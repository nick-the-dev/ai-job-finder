import crypto from 'crypto';
import { getDb } from '../../db/client.js';
import { NormalizerService } from '../../services/normalizer.js';
import { MatcherAgent } from '../../agents/matcher.js';
import { LocationNormalizerAgent } from '../../agents/location-normalizer.js';
import { sendMatchSummary } from '../../telegram/services/notification.js';
import { logger } from '../../utils/logger.js';
import { queueService, PRIORITY, type Priority } from '../../queue/index.js';
import { RunTracker, updateSkillStats, createMarketSnapshot, type ErrorContext } from '../../observability/index.js';
import type { NormalizedJob, JobMatchResult, RawJob } from '../../core/types.js';
import type { NormalizedLocation } from '../../schemas/llm-outputs.js';

// Services (reuse singleton pattern)
const normalizer = new NormalizerService();
const matcher = new MatcherAgent();

type DatePostedType = 'today' | '3days' | 'week' | 'month' | 'all';

interface CollectionParams {
  jobTitles: string[];
  normalizedLocations: NormalizedLocation[] | null;
  legacyLocation: string | null;
  legacyIsRemote: boolean;
  datePosted: DatePostedType;
  limit: number;
  skipCache: boolean;
  priority: Priority;
}

/**
 * Collect jobs for a subscription, supporting multi-location search.
 * Uses normalizedLocations if available, falls back to legacy location/isRemote.
 */
async function collectJobsForSubscription(params: CollectionParams): Promise<RawJob[]> {
  const { jobTitles, normalizedLocations, legacyLocation, legacyIsRemote, datePosted, limit, skipCache, priority } = params;
  const allRawJobs: RawJob[] = [];

  // Use normalized locations if available
  if (normalizedLocations && normalizedLocations.length > 0) {
    const physicalLocations = LocationNormalizerAgent.getPhysicalLocations(normalizedLocations);
    const hasRemote = LocationNormalizerAgent.hasRemote(normalizedLocations);

    for (const title of jobTitles) {
      // Search for remote jobs if user wants remote
      if (hasRemote) {
        try {
          logger.info('Scheduler', `  Collecting remote jobs for: "${title}"`);
          const jobs = await queueService.enqueueCollection({
            query: title,
            isRemote: true,
            limit,
            source: 'jobspy',
            skipCache,
            datePosted: datePosted === 'all' ? undefined : datePosted,
          }, priority);
          logger.info('Scheduler', `  Found ${jobs.length} remote jobs for "${title}"`);
          allRawJobs.push(...jobs);
        } catch (error) {
          logger.error('Scheduler', `  Failed to collect remote jobs for "${title}"`, error);
        }
      }

      // Search for each physical location using first 2 searchVariants
      for (const loc of physicalLocations) {
        const variants = loc.searchVariants.slice(0, 2);
        if (variants.length === 0) variants.push(loc.display);

        for (const variant of variants) {
          try {
            logger.info('Scheduler', `  Collecting jobs for: "${title}" in "${variant}"`);
            const jobs = await queueService.enqueueCollection({
              query: title,
              location: variant,
              isRemote: false, // Physical locations only
              limit,
              source: 'jobspy',
              skipCache,
              datePosted: datePosted === 'all' ? undefined : datePosted,
            }, priority);
            logger.info('Scheduler', `  Found ${jobs.length} jobs for "${title}" in "${variant}"`);
            allRawJobs.push(...jobs);
          } catch (error) {
            logger.error('Scheduler', `  Failed to collect jobs for "${title}" in "${variant}"`, error);
          }
        }
      }
    }
  } else {
    // Legacy mode: single location
    for (const title of jobTitles) {
      try {
        logger.info('Scheduler', `  Collecting jobs for: "${title}"`);
        const jobs = await queueService.enqueueCollection({
          query: title,
          location: legacyLocation ?? undefined,
          isRemote: legacyIsRemote,
          limit,
          source: 'jobspy',
          skipCache,
          datePosted: datePosted === 'all' ? undefined : datePosted,
        }, priority);
        logger.info('Scheduler', `  Found ${jobs.length} jobs for "${title}"`);
        allRawJobs.push(...jobs);
      } catch (error) {
        logger.error('Scheduler', `  Failed to collect jobs for "${title}"`, error);
      }
    }
  }

  return allRawJobs;
}

/**
 * Filter jobs by location using normalized locations or legacy location.
 */
function filterJobsByLocation(
  jobs: NormalizedJob[],
  normalizedLocations: NormalizedLocation[] | null,
  legacyLocation: string | null
): NormalizedJob[] {
  // Use normalized locations if available
  if (normalizedLocations && normalizedLocations.length > 0) {
    // No location filter if locations array is empty (user selected "Anywhere")
    // Already handled: normalizedLocations.length > 0

    return jobs.filter(job =>
      LocationNormalizerAgent.matchesJob(normalizedLocations, {
        location: job.location,
        isRemote: job.isRemote,
      })
    );
  }

  // Legacy location filter
  if (legacyLocation) {
    const locationParts = legacyLocation.toLowerCase().split(/[,\s]+/).filter(p => p.length > 2);
    return jobs.filter(job => {
      // Always include remote jobs
      if (job.isRemote) return true;

      // Check if job location matches any part
      const jobLocationLower = (job.location || '').toLowerCase();
      for (const part of locationParts) {
        if (jobLocationLower.includes(part)) return true;
      }
      return false;
    });
  }

  // No location filter
  return jobs;
}

interface SearchResult {
  usersProcessed: number;
  matchesFound: number;
  notificationsSent: number;
}

interface SingleSearchResult {
  matchesFound: number;
  notificationsSent: number;
  stats: MatchStats;
  jobsProcessed: number;
}

export interface MatchStats {
  skippedAlreadySent: number;
  skippedBelowScore: number;
  skippedCrossSubDuplicates: number;
  previouslyMatchedOther: number;
}

export interface MatchItem {
  job: NormalizedJob;
  match: JobMatchResult;
  matchId: string;
  isPreviouslyMatched: boolean;
}

// Run search for a single subscription (used for immediate scan)
export async function runSingleSubscriptionSearch(subscriptionId: string): Promise<SingleSearchResult> {
  const db = getDb();

  // Start tracking the run
  const runId = await RunTracker.start(subscriptionId, 'manual');

  const sub = await db.searchSubscription.findUnique({
    where: { id: subscriptionId },
    include: {
      user: {
        include: {
          subscriptions: {
            select: { id: true, sentNotifications: { select: { jobMatchId: true } } },
          },
        },
      },
      sentNotifications: { select: { jobMatchId: true } },
    },
  });

  if (!sub || !sub.isActive) {
    await RunTracker.fail(runId, new Error('Subscription not found or inactive'));
    throw new Error('Subscription not found or inactive');
  }

  // Build Sets for O(1) deduplication lookups
  const thisSentIds = new Set(sub.sentNotifications.map(n => n.jobMatchId));
  const otherSentIds = new Set(
    sub.user.subscriptions
      .filter(s => s.id !== sub.id)
      .flatMap(s => s.sentNotifications.map(n => n.jobMatchId))
  );
  const skipDupes = sub.user.skipCrossSubDuplicates;

  const userLabel = sub.user.username
    ? `@${sub.user.username}`
    : `user-${sub.user.telegramId}`;

  logger.info('Scheduler', `[Manual] Scanning for ${userLabel}: ${sub.jobTitles.join(', ')}`);

  // Track current context for error reporting
  let errorContext: ErrorContext = {
    stage: 'collection',
    partialResults: { jobsCollected: 0, jobsNormalized: 0, jobsMatched: 0 },
  };

  try {
  // Parse normalized locations from JSON field
  const normalizedLocations = sub.normalizedLocations as NormalizedLocation[] | null;
  const datePosted = (sub.datePosted || 'month') as DatePostedType;

  // Stage 1: Collection
  errorContext.stage = 'collection';
  errorContext.query = sub.jobTitles.join(', ');
  errorContext.location = sub.location ?? (normalizedLocations ? LocationNormalizerAgent.formatForDisplaySingleLine(normalizedLocations) : undefined);

  const allRawJobs = await collectJobsForSubscription({
    jobTitles: sub.jobTitles,
    normalizedLocations,
    legacyLocation: sub.location,
    legacyIsRemote: sub.isRemote,
    datePosted,
    limit: 3000,
    skipCache: true, // Manual scans always fetch fresh results
    priority: PRIORITY.MANUAL_SCAN,
  });

  errorContext.partialResults!.jobsCollected = allRawJobs.length;
  logger.info('Scheduler', `[Manual] Total raw jobs collected: ${allRawJobs.length}`);

  // Stage 2: Normalization
  errorContext.stage = 'normalization';
  let normalizedJobs = await normalizer.execute(allRawJobs);
  errorContext.partialResults!.jobsNormalized = normalizedJobs.length;
  logger.info('Scheduler', `[Manual] After dedup: ${normalizedJobs.length} unique jobs`);

  // Apply exclusion filters
  const excludedTitles = sub.excludedTitles ?? [];
  const excludedCompanies = sub.excludedCompanies ?? [];

  if (excludedTitles.length > 0 || excludedCompanies.length > 0) {
    normalizedJobs = normalizedJobs.filter((job) => {
      const titleLower = job.title.toLowerCase();
      for (const excluded of excludedTitles) {
        if (titleLower.includes(excluded.toLowerCase())) return false;
      }
      const companyLower = job.company.toLowerCase();
      for (const excluded of excludedCompanies) {
        if (companyLower.includes(excluded.toLowerCase())) return false;
      }
      return true;
    });
  }

  // Apply location filter using normalized locations or legacy location
  const beforeLocationFilter = normalizedJobs.length;
  normalizedJobs = filterJobsByLocation(normalizedJobs, normalizedLocations, sub.location);
  const locationFiltered = beforeLocationFilter - normalizedJobs.length;
  if (locationFiltered > 0) {
    logger.info('Scheduler', `[Manual] Filtered ${locationFiltered} jobs by location`);
  }

  // Stage 3: Matching
  errorContext.stage = 'matching';
  const newMatches: MatchItem[] = [];
  const stats: MatchStats = { skippedAlreadySent: 0, skippedBelowScore: 0, skippedCrossSubDuplicates: 0, previouslyMatchedOther: 0 };

  for (const job of normalizedJobs) {
    // Update context for each job being matched
    errorContext.jobTitle = job.title;
    errorContext.company = job.company;

    try {
      const existingJob = await db.job.findUnique({
        where: { contentHash: job.contentHash },
        include: { matches: { where: { resumeHash: sub.resumeHash }, take: 1 } },
      });

      let matchResult: JobMatchResult;
      let jobMatchId: string;

      if (existingJob?.matches?.[0]) {
        const cached = existingJob.matches[0];
        matchResult = {
          score: cached.score,
          reasoning: cached.reasoning,
          matchedSkills: cached.matchedSkills,
          missingSkills: cached.missingSkills,
          pros: cached.pros,
          cons: cached.cons,
        };
        jobMatchId = cached.id;
      } else {
        matchResult = await matcher.execute({ job, resumeText: sub.resumeText });

        const savedJob = await db.job.upsert({
          where: { contentHash: job.contentHash },
          create: {
            contentHash: job.contentHash,
            title: job.title,
            company: job.company,
            description: job.description,
            location: job.location,
            isRemote: job.isRemote || false,
            salaryMin: job.salaryMin,
            salaryMax: job.salaryMax,
            salaryCurrency: job.salaryCurrency,
            source: job.source,
            sourceId: job.sourceId,
            applicationUrl: job.applicationUrl,
            postedDate: job.postedDate,
          },
          update: { lastSeenAt: new Date() },
        });

        let savedMatch = await db.jobMatch.findFirst({
          where: { jobId: savedJob.id, resumeHash: sub.resumeHash },
        });

        if (!savedMatch) {
          savedMatch = await db.jobMatch.create({
            data: {
              jobId: savedJob.id,
              resumeHash: sub.resumeHash,
              score: Math.round(matchResult.score),
              reasoning: matchResult.reasoning,
              matchedSkills: matchResult.matchedSkills ?? [],
              missingSkills: matchResult.missingSkills ?? [],
              pros: matchResult.pros ?? [],
              cons: matchResult.cons ?? [],
            },
          });
        }

        jobMatchId = savedMatch.id;
      }

      // Track stats and apply filters
      if (matchResult.score < sub.minScore) {
        stats.skippedBelowScore++;
        continue;
      }
      if (thisSentIds.has(jobMatchId)) {
        stats.skippedAlreadySent++;
        continue;
      }
      const isPreviouslyMatched = otherSentIds.has(jobMatchId);
      if (isPreviouslyMatched && skipDupes) {
        stats.skippedCrossSubDuplicates++;
        continue;
      }
      if (isPreviouslyMatched) stats.previouslyMatchedOther++;

      newMatches.push({ job, match: matchResult, matchId: jobMatchId, isPreviouslyMatched });
      errorContext.partialResults!.jobsMatched = newMatches.length;
    } catch (error) {
      logger.error('Scheduler', `[Manual] Failed to process job: ${job.title}`, error);
    }
  }

  // Clear job-specific context after matching loop
  delete errorContext.jobTitle;
  delete errorContext.company;

  // Update run stats mid-execution
  await RunTracker.update(runId, {
    jobsCollected: allRawJobs.length,
    jobsAfterDedup: normalizedJobs.length,
    jobsMatched: newMatches.length,
  });

  let notificationsSent = 0;

  if (newMatches.length > 0) {
    // Stage 4: Notification
    errorContext.stage = 'notification';
    newMatches.sort((a, b) => b.match.score - a.match.score);

    await sendMatchSummary(sub.user.chatId, newMatches, stats);

    // Use createMany with skipDuplicates to handle concurrent runs safely
    const created = await db.sentNotification.createMany({
      data: newMatches.map(({ matchId }) => ({
        subscriptionId: sub.id,
        jobMatchId: matchId,
      })),
      skipDuplicates: true,
    });

    notificationsSent = created.count;
  }

  // Collect skill data for analytics
  const allMatchedSkills = newMatches.flatMap(m => m.match.matchedSkills ?? []);
  const allMissingSkills = newMatches.flatMap(m => m.match.missingSkills ?? []);
  if (allMatchedSkills.length > 0 || allMissingSkills.length > 0) {
    await updateSkillStats(subscriptionId, allMatchedSkills, allMissingSkills);
  }

  // Create market snapshot for analytics
  if (normalizedJobs.length > 0) {
    await createMarketSnapshot(sub.jobTitles, sub.location, sub.isRemote, normalizedJobs);
  }

  // Update last search timestamp
  await db.searchSubscription.update({
    where: { id: sub.id },
    data: { lastSearchAt: new Date() },
  });

  // Complete the run tracking
  await RunTracker.complete(runId, {
    jobsCollected: allRawJobs.length,
    jobsAfterDedup: normalizedJobs.length,
    jobsMatched: newMatches.length,
    notificationsSent,
  });

  logger.info('Scheduler', `[Manual] Results: ${newMatches.length} new | ${stats.skippedAlreadySent} already sent | ${stats.skippedBelowScore} below threshold | ${stats.skippedCrossSubDuplicates} cross-sub skipped`);

  return { matchesFound: newMatches.length, notificationsSent, stats, jobsProcessed: normalizedJobs.length };

  } catch (error) {
    // Capture additional debug info before failing
    errorContext.subscriptionId = subscriptionId;
    errorContext.userId = sub.userId;
    errorContext.username = sub.user.username ?? undefined;
    errorContext.jobTitles = sub.jobTitles;
    errorContext.minScore = sub.minScore;
    errorContext.datePosted = sub.datePosted;
    errorContext.triggerType = 'manual';
    errorContext.timestamp = new Date().toISOString();

    await RunTracker.fail(runId, error, errorContext);
    throw error;
  }
}

export async function runSubscriptionSearches(): Promise<SearchResult> {
  const db = getDb();

  // Get all active, non-paused subscriptions
  const subscriptions = await db.searchSubscription.findMany({
    where: {
      isActive: true,
      isPaused: false,
    },
    include: {
      user: {
        include: {
          subscriptions: {
            select: { id: true, sentNotifications: { select: { jobMatchId: true } } },
          },
        },
      },
      sentNotifications: { select: { jobMatchId: true } },
    },
  });

  if (subscriptions.length === 0) {
    logger.info('Scheduler', 'No active subscriptions to process');
    return { usersProcessed: 0, matchesFound: 0, notificationsSent: 0 };
  }

  logger.info('Scheduler', `Processing ${subscriptions.length} active subscriptions`);

  let totalMatchesFound = 0;
  let totalNotifications = 0;

  for (const sub of subscriptions) {
    // Start tracking the run for each subscription
    const runId = await RunTracker.start(sub.id, 'scheduled');

    // Track context for error reporting
    const errorContext: ErrorContext = {
      stage: 'collection',
      subscriptionId: sub.id,
      userId: sub.userId,
      username: sub.user.username ?? undefined,
      jobTitles: sub.jobTitles,
      triggerType: 'scheduled',
      partialResults: { jobsCollected: 0, jobsNormalized: 0, jobsMatched: 0 },
    };

    try {
      const userLabel = sub.user.username
        ? `@${sub.user.username}`
        : `user-${sub.user.telegramId}`;

      logger.info('Scheduler', `Processing ${userLabel}: ${sub.jobTitles.join(', ')}`);

      // Build Sets for O(1) deduplication lookups
      const thisSentIds = new Set(sub.sentNotifications.map(n => n.jobMatchId));
      const otherSentIds = new Set(
        sub.user.subscriptions
          .filter(s => s.id !== sub.id)
          .flatMap(s => s.sentNotifications.map(n => n.jobMatchId))
      );
      const skipDupes = sub.user.skipCrossSubDuplicates;

      // Parse normalized locations from JSON field
      const normalizedLocations = sub.normalizedLocations as NormalizedLocation[] | null;
      const datePosted = (sub.datePosted || 'month') as DatePostedType;

      // Update context with location info
      errorContext.query = sub.jobTitles.join(', ');
      errorContext.location = sub.location ?? (normalizedLocations ? LocationNormalizerAgent.formatForDisplaySingleLine(normalizedLocations) : undefined);
      errorContext.minScore = sub.minScore;
      errorContext.datePosted = sub.datePosted;

      // Stage 1: Collection
      errorContext.stage = 'collection';
      const allRawJobs = await collectJobsForSubscription({
        jobTitles: sub.jobTitles,
        normalizedLocations,
        legacyLocation: sub.location,
        legacyIsRemote: sub.isRemote,
        datePosted,
        limit: 3000,
        skipCache: false,
        priority: PRIORITY.SCHEDULED,
      });

      errorContext.partialResults!.jobsCollected = allRawJobs.length;
      logger.info('Scheduler', `  Total collected: ${allRawJobs.length} raw jobs`);

      // Stage 2: Normalization
      errorContext.stage = 'normalization';
      let normalizedJobs = await normalizer.execute(allRawJobs);
      errorContext.partialResults!.jobsNormalized = normalizedJobs.length;
      logger.debug('Scheduler', `  ${normalizedJobs.length} unique jobs after dedup`);

      // Step 2.5: Apply exclusion filters
      const excludedTitles = sub.excludedTitles ?? [];
      const excludedCompanies = sub.excludedCompanies ?? [];

      if (excludedTitles.length > 0 || excludedCompanies.length > 0) {
        const beforeFilter = normalizedJobs.length;
        normalizedJobs = normalizedJobs.filter((job) => {
          // Check excluded titles (case-insensitive partial match)
          const titleLower = job.title.toLowerCase();
          for (const excluded of excludedTitles) {
            if (titleLower.includes(excluded.toLowerCase())) {
              return false;
            }
          }
          // Check excluded companies (case-insensitive partial match)
          const companyLower = job.company.toLowerCase();
          for (const excluded of excludedCompanies) {
            if (companyLower.includes(excluded.toLowerCase())) {
              return false;
            }
          }
          return true;
        });
        const filtered = beforeFilter - normalizedJobs.length;
        if (filtered > 0) {
          logger.debug('Scheduler', `  Filtered ${filtered} jobs by exclusions`);
        }
      }

      // Step 2.6: Apply location filter using normalized locations or legacy location
      const beforeLocationFilter = normalizedJobs.length;
      normalizedJobs = filterJobsByLocation(normalizedJobs, normalizedLocations, sub.location);
      const locationFiltered = beforeLocationFilter - normalizedJobs.length;
      if (locationFiltered > 0) {
        logger.info('Scheduler', `  Filtered ${locationFiltered} jobs by location`);
      }

      // Stage 3: Matching
      errorContext.stage = 'matching';
      const newMatches: MatchItem[] = [];
      const stats: MatchStats = { skippedAlreadySent: 0, skippedBelowScore: 0, skippedCrossSubDuplicates: 0, previouslyMatchedOther: 0 };

      for (const job of normalizedJobs) {
        errorContext.jobTitle = job.title;
        errorContext.company = job.company;

        try {
          // Check for existing match in DB
          const existingJob = await db.job.findUnique({
            where: { contentHash: job.contentHash },
            include: {
              matches: {
                where: { resumeHash: sub.resumeHash },
                take: 1,
              },
            },
          });

          let matchResult: JobMatchResult;
          let jobMatchId: string;

          if (existingJob?.matches?.[0]) {
            // Use cached match
            const cached = existingJob.matches[0];
            matchResult = {
              score: cached.score,
              reasoning: cached.reasoning,
              matchedSkills: cached.matchedSkills,
              missingSkills: cached.missingSkills,
              pros: cached.pros,
              cons: cached.cons,
            };
            jobMatchId = cached.id;
          } else {
            // Need to create new match via LLM
            matchResult = await matcher.execute({
              job,
              resumeText: sub.resumeText,
            });

            // Save job and match to DB
            const savedJob = await db.job.upsert({
              where: { contentHash: job.contentHash },
              create: {
                contentHash: job.contentHash,
                title: job.title,
                company: job.company,
                description: job.description,
                location: job.location,
                isRemote: job.isRemote || false,
                salaryMin: job.salaryMin,
                salaryMax: job.salaryMax,
                salaryCurrency: job.salaryCurrency,
                source: job.source,
                sourceId: job.sourceId,
                applicationUrl: job.applicationUrl,
                postedDate: job.postedDate,
              },
              update: { lastSeenAt: new Date() },
            });

            // Find or create match record
            let savedMatch = await db.jobMatch.findFirst({
              where: { jobId: savedJob.id, resumeHash: sub.resumeHash },
            });

            if (!savedMatch) {
              savedMatch = await db.jobMatch.create({
                data: {
                  jobId: savedJob.id,
                  resumeHash: sub.resumeHash,
                  score: Math.round(matchResult.score),
                  reasoning: matchResult.reasoning,
                  matchedSkills: matchResult.matchedSkills ?? [],
                  missingSkills: matchResult.missingSkills ?? [],
                  pros: matchResult.pros ?? [],
                  cons: matchResult.cons ?? [],
                },
              });
            }

            jobMatchId = savedMatch.id;
          }

          // Track stats and apply filters
          if (matchResult.score < sub.minScore) {
            stats.skippedBelowScore++;
            continue;
          }
          if (thisSentIds.has(jobMatchId)) {
            stats.skippedAlreadySent++;
            continue;
          }
          const isPreviouslyMatched = otherSentIds.has(jobMatchId);
          if (isPreviouslyMatched && skipDupes) {
            stats.skippedCrossSubDuplicates++;
            continue;
          }
          if (isPreviouslyMatched) stats.previouslyMatchedOther++;

          newMatches.push({ job, match: matchResult, matchId: jobMatchId, isPreviouslyMatched });
          errorContext.partialResults!.jobsMatched = newMatches.length;
        } catch (error) {
          logger.error('Scheduler', `  Failed to process job: ${job.title}`, error);
        }
      }

      // Clear job-specific context after matching loop
      delete errorContext.jobTitle;
      delete errorContext.company;

      logger.info('Scheduler', `  Results: ${newMatches.length} new | ${stats.skippedAlreadySent} already sent | ${stats.skippedBelowScore} below threshold | ${stats.skippedCrossSubDuplicates} cross-sub skipped`);
      totalMatchesFound += newMatches.length;

      let notificationsSent = 0;
      if (newMatches.length > 0) {
        // Stage 4: Notification
        errorContext.stage = 'notification';
        newMatches.sort((a, b) => b.match.score - a.match.score);

        try {
          await sendMatchSummary(sub.user.chatId, newMatches, stats);

          // Use createMany with skipDuplicates to handle concurrent runs safely
          const created = await db.sentNotification.createMany({
            data: newMatches.map(({ matchId }) => ({
              subscriptionId: sub.id,
              jobMatchId: matchId,
            })),
            skipDuplicates: true,
          });

          notificationsSent = created.count;
          totalNotifications += newMatches.length;
          logger.info('Scheduler', `  Sent ${newMatches.length} notifications to ${userLabel}`);
        } catch (error) {
          logger.error('Scheduler', `  Failed to send notifications to ${userLabel}`, error);
        }
      }

      // Collect skill data for analytics
      const allMatchedSkills = newMatches.flatMap(m => m.match.matchedSkills ?? []);
      const allMissingSkills = newMatches.flatMap(m => m.match.missingSkills ?? []);
      if (allMatchedSkills.length > 0 || allMissingSkills.length > 0) {
        await updateSkillStats(sub.id, allMatchedSkills, allMissingSkills);
      }

      // Create market snapshot for analytics
      if (normalizedJobs.length > 0) {
        await createMarketSnapshot(sub.jobTitles, sub.location, sub.isRemote, normalizedJobs);
      }

      // Update last search timestamp
      await db.searchSubscription.update({
        where: { id: sub.id },
        data: { lastSearchAt: new Date() },
      });

      // Complete the run tracking
      await RunTracker.complete(runId, {
        jobsCollected: allRawJobs.length,
        jobsAfterDedup: normalizedJobs.length,
        jobsMatched: newMatches.length,
        notificationsSent,
      });
    } catch (error) {
      errorContext.timestamp = new Date().toISOString();
      await RunTracker.fail(runId, error, errorContext);
      logger.error(
        'Scheduler',
        `Failed to process subscription for user ${sub.user.telegramId}`,
        error
      );
      // Continue with next user
    }
  }

  return {
    usersProcessed: subscriptions.length,
    matchesFound: totalMatchesFound,
    notificationsSent: totalNotifications,
  };
}
