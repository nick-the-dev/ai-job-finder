import crypto from 'crypto';
import pLimit from 'p-limit';
import { getDb } from '../../db/client.js';
import { CollectorService } from '../../services/collector.js';
import { NormalizerService } from '../../services/normalizer.js';
import { MatcherAgent } from '../../agents/matcher.js';
import { sendMatchSummary } from '../../telegram/services/notification.js';
import { logger } from '../../utils/logger.js';
import type { NormalizedJob, JobMatchResult } from '../../core/types.js';

// Rate limit JobSpy requests
const jobspyLimit = pLimit(2);

// Services (reuse singleton pattern)
const collector = new CollectorService();
const normalizer = new NormalizerService();
const matcher = new MatcherAgent();

interface SearchResult {
  usersProcessed: number;
  matchesFound: number;
  notificationsSent: number;
}

interface SingleSearchResult {
  matchesFound: number;
  notificationsSent: number;
}

// Run search for a single subscription (used for immediate scan)
export async function runSingleSubscriptionSearch(subscriptionId: string): Promise<SingleSearchResult> {
  const db = getDb();

  const sub = await db.searchSubscription.findUnique({
    where: { id: subscriptionId },
    include: {
      user: true,
      sentNotifications: {
        select: { jobMatchId: true },
      },
    },
  });

  if (!sub || !sub.isActive) {
    throw new Error('Subscription not found or inactive');
  }

  const userLabel = sub.user.username
    ? `@${sub.user.username}`
    : `user-${sub.user.telegramId}`;

  logger.info('Scheduler', `[Manual] Scanning for ${userLabel}: ${sub.jobTitles.join(', ')}`);

  // Collect jobs for each title using user's date preference
  type DatePostedType = 'today' | '3days' | 'week' | 'month' | 'all';
  const datePosted = (sub.datePosted || 'month') as DatePostedType;
  const allRawJobs = [];

  for (const title of sub.jobTitles) {
    try {
      logger.info('Scheduler', `[Manual] Collecting jobs for: "${title}"`);
      const collectFn = async () => {
        const jobs = await collector.execute({
          query: title,
          location: sub.location ?? undefined,
          isRemote: sub.isRemote,
          limit: 3000,
          source: 'jobspy',
          skipCache: false,
          datePosted: datePosted === 'all' ? undefined : datePosted,
        });
        return jobs;
      };
      const jobs = await jobspyLimit(collectFn);
      logger.info('Scheduler', `[Manual] Found ${jobs.length} jobs for "${title}"`);
      allRawJobs.push(...jobs);
    } catch (error) {
      logger.error('Scheduler', `[Manual] Failed to collect jobs for "${title}"`, error);
      // Continue with other titles
    }
  }

  logger.info('Scheduler', `[Manual] Total raw jobs collected: ${allRawJobs.length}`);

  // Normalize and dedupe
  let normalizedJobs = await normalizer.execute(allRawJobs);
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

  // Apply location filter if user specified a location
  if (sub.location) {
    const beforeLocationFilter = normalizedJobs.length;
    // Extract key parts from user's location (e.g., "Toronto, Ontario, Canada" -> ["toronto", "ontario", "canada"])
    const locationParts = sub.location.toLowerCase().split(/[,\s]+/).filter(p => p.length > 2);

    normalizedJobs = normalizedJobs.filter((job) => {
      // Always include remote jobs - they can work from user's location
      if (job.isRemote) return true;

      // Check if job location contains any part of user's location
      const jobLocationLower = (job.location || '').toLowerCase();
      for (const part of locationParts) {
        if (jobLocationLower.includes(part)) return true;
      }
      return false;
    });

    const filtered = beforeLocationFilter - normalizedJobs.length;
    if (filtered > 0) {
      logger.info('Scheduler', `[Manual] Filtered ${filtered} jobs outside "${sub.location}"`);
    }
  }

  // Get already-sent job match IDs
  const sentJobMatchIds = new Set(sub.sentNotifications.map((n) => n.jobMatchId));

  // Match jobs and find NEW matches
  const newMatches: Array<{
    job: NormalizedJob;
    match: JobMatchResult;
    matchId: string;
  }> = [];

  for (const job of normalizedJobs) {
    try {
      const existingJob = await db.job.findUnique({
        where: { contentHash: job.contentHash },
        include: {
          matches: { where: { resumeHash: sub.resumeHash }, take: 1 },
        },
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

      if (matchResult.score >= sub.minScore && !sentJobMatchIds.has(jobMatchId)) {
        newMatches.push({ job, match: matchResult, matchId: jobMatchId });
      }
    } catch (error) {
      logger.error('Scheduler', `[Manual] Failed to process job: ${job.title}`, error);
    }
  }

  let notificationsSent = 0;

  if (newMatches.length > 0) {
    newMatches.sort((a, b) => b.match.score - a.match.score);
    const toNotify = newMatches.slice(0, 10);

    await sendMatchSummary(
      sub.user.chatId,
      toNotify.map(({ job, match }) => ({ job, match }))
    );

    for (const { matchId } of toNotify) {
      await db.sentNotification.create({
        data: { subscriptionId: sub.id, jobMatchId: matchId },
      });
    }

    notificationsSent = toNotify.length;
  }

  // Update last search timestamp
  await db.searchSubscription.update({
    where: { id: sub.id },
    data: { lastSearchAt: new Date() },
  });

  logger.info('Scheduler', `[Manual] Found ${newMatches.length} matches, sent ${notificationsSent} notifications`);

  return { matchesFound: newMatches.length, notificationsSent };
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
      user: true,
      sentNotifications: {
        select: { jobMatchId: true },
      },
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
    try {
      const userLabel = sub.user.username
        ? `@${sub.user.username}`
        : `user-${sub.user.telegramId}`;

      logger.info('Scheduler', `Processing ${userLabel}: ${sub.jobTitles.join(', ')}`);

      // Step 1: Collect jobs for each title using user's date preference
      type DatePostedType = 'today' | '3days' | 'week' | 'month' | 'all';
      const datePosted = (sub.datePosted || 'month') as DatePostedType;
      const allRawJobs = [];

      for (const title of sub.jobTitles) {
        try {
          logger.info('Scheduler', `  Collecting jobs for: "${title}"`);
          const collectFn = async () => {
            const jobs = await collector.execute({
              query: title,
              location: sub.location ?? undefined,
              isRemote: sub.isRemote,
              limit: 3000,
              source: 'jobspy',
              skipCache: false,
              datePosted: datePosted === 'all' ? undefined : datePosted,
            });
            return jobs;
          };

          // Rate limit JobSpy
          const jobs = await jobspyLimit(collectFn);
          logger.info('Scheduler', `  Found ${jobs.length} jobs for "${title}"`);
          allRawJobs.push(...jobs);
        } catch (error) {
          logger.error('Scheduler', `  Failed to collect jobs for "${title}"`, error);
          // Continue with other titles
        }
      }

      logger.info('Scheduler', `  Total collected: ${allRawJobs.length} raw jobs`);

      // Step 2: Normalize and dedupe
      let normalizedJobs = await normalizer.execute(allRawJobs);
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

      // Step 2.6: Apply location filter if user specified a location
      if (sub.location) {
        const beforeLocationFilter = normalizedJobs.length;
        // Extract key parts from user's location (e.g., "Toronto, Ontario, Canada" -> ["toronto", "ontario", "canada"])
        const locationParts = sub.location.toLowerCase().split(/[,\s]+/).filter(p => p.length > 2);

        normalizedJobs = normalizedJobs.filter((job) => {
          // Always include remote jobs - they can work from user's location
          if (job.isRemote) return true;

          // Check if job location contains any part of user's location
          const jobLocationLower = (job.location || '').toLowerCase();
          for (const part of locationParts) {
            if (jobLocationLower.includes(part)) return true;
          }
          return false;
        });

        const filtered = beforeLocationFilter - normalizedJobs.length;
        if (filtered > 0) {
          logger.info('Scheduler', `  Filtered ${filtered} jobs outside "${sub.location}"`);
        }
      }

      // Step 3: Get already-sent job match IDs
      const sentJobMatchIds = new Set(sub.sentNotifications.map((n) => n.jobMatchId));

      // Step 4: Match jobs and find NEW matches
      const newMatches: Array<{
        job: NormalizedJob;
        match: JobMatchResult;
        matchId: string;
      }> = [];

      for (const job of normalizedJobs) {
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

          // Check if meets minScore and hasn't been sent before
          if (matchResult.score >= sub.minScore && !sentJobMatchIds.has(jobMatchId)) {
            newMatches.push({ job, match: matchResult, matchId: jobMatchId });
          }
        } catch (error) {
          logger.error('Scheduler', `  Failed to process job: ${job.title}`, error);
        }
      }

      logger.info('Scheduler', `  Found ${newMatches.length} new matches (score >= ${sub.minScore})`);
      totalMatchesFound += newMatches.length;

      if (newMatches.length > 0) {
        // Sort by score descending, take top 10
        newMatches.sort((a, b) => b.match.score - a.match.score);
        const toNotify = newMatches.slice(0, 10);

        // Send notification summary
        try {
          await sendMatchSummary(
            sub.user.chatId,
            toNotify.map(({ job, match }) => ({ job, match }))
          );

          // Record all as sent
          for (const { matchId } of toNotify) {
            await db.sentNotification.create({
              data: {
                subscriptionId: sub.id,
                jobMatchId: matchId,
              },
            });
          }

          totalNotifications += toNotify.length;
          logger.info('Scheduler', `  Sent ${toNotify.length} notifications to ${userLabel}`);
        } catch (error) {
          logger.error('Scheduler', `  Failed to send notifications to ${userLabel}`, error);
        }
      }

      // Update last search timestamp
      await db.searchSubscription.update({
        where: { id: sub.id },
        data: { lastSearchAt: new Date() },
      });
    } catch (error) {
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
