import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { getDb } from '../../db/client.js';
import { NormalizerService } from '../../services/normalizer.js';
import { MatcherAgent } from '../../agents/matcher.js';
import { LocationNormalizerAgent } from '../../agents/location-normalizer.js';
import { sendMatchSummary, type SubscriptionContext } from '../../telegram/services/notification.js';
import { logger, createSubscriptionLogger, type SubscriptionLogger } from '../../utils/logger.js';
import { queueService, PRIORITY, type Priority } from '../../queue/index.js';
import { RunTracker, formatTriggerLabel, updateSkillStats, createMarketSnapshot, type ErrorContext, type TriggerType, type ProgressUpdate } from '../../observability/index.js';
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
  jobTypes: string[]; // fulltime, parttime, internship, contract (empty = all)
  datePosted: DatePostedType;
  limit: number;
  skipCache: boolean;
  priority: Priority;
  subLogger?: SubscriptionLogger; // Optional subscription-scoped logger for debug mode
  onProgress?: (current: number, total: number, detail: string) => Promise<void>; // Progress callback
}

interface CollectionError {
  query: string;
  location?: string;
  jobType?: string;
  error: string;
}

interface CollectionResult {
  jobs: RawJob[];
  queriesTotal: number;
  queriesFailed: number;
  errors: CollectionError[];
}

/**
 * Checkpoint data for resuming interrupted runs.
 * Stored in subscription_runs.checkpoint column.
 */
interface MatchingCheckpoint extends Record<string, unknown> {
  stage: 'matching';
  normalizedJobs: NormalizedJob[];  // Full job list (stored once, on first save)
  currentIndex: number;              // Current position in the loop
  matchedJobIds: string[];           // IDs of jobs added to newMatches
  processedHashes: string[];         // Content hashes of all processed jobs (for skip on resume)
  stats: {
    skippedBelowScore: number;
    skippedAlreadySent: number;
    skippedCrossSubDuplicates: number;
    previouslyMatchedOther: number;
  };
  failedJobHashes: string[];         // Jobs that failed matching (skip on resume)
}

interface CollectionCheckpoint {
  stage: 'collection';
  queriesCompleted: number;
  queriesTotal: number;
  collectedJobs: RawJob[];           // Partial collection results
}

export type RunCheckpoint = MatchingCheckpoint | CollectionCheckpoint | { stage: string };

// Export checkpoint types for use in cron.ts
export type { MatchingCheckpoint, CollectionCheckpoint };

/**
 * Dynamic progress calculator that adjusts phase allocations based on actual job counts.
 *
 * Time estimates:
 * - Each collection query: ~4 seconds
 * - Normalization: ~0.5 seconds per 100 jobs (negligible)
 * - Each matching call: ~1.5 seconds (when cache miss, ~0.1s for cache hit - average ~1s)
 * - Notifications: ~0.5 seconds per batch
 *
 * This ensures progress reflects actual time/complexity remaining.
 */
class ProgressCalculator {
  private collectionPercent: number = 30;
  private normalizationPercent: number = 5;
  private matchingPercent: number = 60;
  private notificationPercent: number = 5;
  private collectionEndPercent: number = 30;
  private normalizationEndPercent: number = 35;
  private matchingEndPercent: number = 95;

  constructor(queryCount: number, estimatedJobCount: number = 0) {
    // Initial estimate before we know job count
    // Collection is the only work we're sure about
    this.recalculate(queryCount, estimatedJobCount);
  }

  /**
   * Recalculate phase allocations based on actual counts.
   * Called after collection when we know the real job count.
   */
  recalculate(queryCount: number, jobCount: number) {
    // Time estimates in seconds
    const collectionTime = queryCount * 4;          // ~4s per query
    const normalizationTime = Math.max(0.5, jobCount * 0.005); // ~0.5s per 100 jobs, min 0.5s
    const matchingTime = jobCount * 1.0;            // ~1s per job (avg of cache hit/miss)
    const notificationTime = 1;                     // ~1s for sending

    const totalTime = collectionTime + normalizationTime + matchingTime + notificationTime;

    // Calculate percentages (ensure minimum 5% for each visible phase)
    this.collectionPercent = Math.max(5, Math.round(100 * collectionTime / totalTime));
    this.normalizationPercent = Math.max(2, Math.round(100 * normalizationTime / totalTime));
    this.matchingPercent = Math.max(5, Math.round(100 * matchingTime / totalTime));
    this.notificationPercent = Math.max(3, Math.round(100 * notificationTime / totalTime));

    // Normalize to 100%
    const total = this.collectionPercent + this.normalizationPercent + this.matchingPercent + this.notificationPercent;
    const scale = 100 / total;
    this.collectionPercent = Math.round(this.collectionPercent * scale);
    this.normalizationPercent = Math.round(this.normalizationPercent * scale);
    this.matchingPercent = Math.round(this.matchingPercent * scale);
    this.notificationPercent = 100 - this.collectionPercent - this.normalizationPercent - this.matchingPercent;

    // Cache end percentages for easier calculation
    this.collectionEndPercent = this.collectionPercent;
    this.normalizationEndPercent = this.collectionEndPercent + this.normalizationPercent;
    this.matchingEndPercent = this.normalizationEndPercent + this.matchingPercent;
  }

  /** Get progress during collection phase (0 to collectionEnd%) */
  collection(current: number, total: number): number {
    const phaseProgress = total > 0 ? current / total : 0;
    return Math.round(phaseProgress * this.collectionPercent);
  }

  /** Get progress at start of normalization */
  normalizationStart(): number {
    return this.collectionEndPercent;
  }

  /** Get progress at end of normalization */
  normalizationEnd(): number {
    return this.normalizationEndPercent;
  }

  /** Get progress during matching phase (normalizationEnd% to matchingEnd%) */
  matching(current: number, total: number): number {
    const phaseProgress = total > 0 ? current / total : 0;
    return this.normalizationEndPercent + Math.round(phaseProgress * this.matchingPercent);
  }

  /** Get progress at start of notification */
  notificationStart(): number {
    return this.matchingEndPercent;
  }

  /** Get allocation summary for debugging */
  getAllocations(): { collection: number; normalization: number; matching: number; notification: number } {
    return {
      collection: this.collectionPercent,
      normalization: this.normalizationPercent,
      matching: this.matchingPercent,
      notification: this.notificationPercent,
    };
  }
}

/**
 * Collect jobs for a subscription, supporting multi-location search.
 * Uses normalizedLocations if available, falls back to legacy location/isRemote.
 * Returns detailed result with error tracking for reliability.
 */
async function collectJobsForSubscription(params: CollectionParams): Promise<CollectionResult> {
  const { jobTitles, normalizedLocations, legacyLocation, legacyIsRemote, jobTypes, datePosted, limit, skipCache, priority, subLogger, onProgress } = params;
  const allRawJobs: RawJob[] = [];
  const errors: CollectionError[] = [];
  let queriesTotal = 0;
  let queriesFailed = 0;
  let queriesCompleted = 0;

  // Debug mode: Log detailed collection parameters
  subLogger?.debug('Collection', 'Starting job collection with params', {
    jobTitles,
    normalizedLocations: normalizedLocations?.map(l => l.display),
    legacyLocation,
    legacyIsRemote,
    jobTypes,
    datePosted,
    limit,
    skipCache,
    priority,
  });

  // Determine job types to search (empty array = search all types with single call)
  const jobTypesToSearch = jobTypes.length > 0 ? jobTypes : [undefined];

  // Use normalized locations if available
  if (normalizedLocations && normalizedLocations.length > 0) {
    const physicalLocations = LocationNormalizerAgent.getPhysicalLocations(normalizedLocations);
    const hasWorldwideRemote = LocationNormalizerAgent.hasWorldwideRemote(normalizedLocations);
    const countrySpecificRemote = LocationNormalizerAgent.getCountrySpecificRemote(normalizedLocations);

    for (const jobType of jobTypesToSearch) {
      const jobTypeLabel = jobType ? ` (${jobType})` : '';

      for (const title of jobTitles) {
        // Search for worldwide remote jobs (no location filter = global search)
        if (hasWorldwideRemote) {
          queriesTotal++;
          try {
            logger.info('Scheduler', `  Collecting remote jobs globally for: "${title}"${jobTypeLabel}`);
            const jobs = await queueService.enqueueCollection({
              query: title,
              isRemote: true,
              jobType: jobType as 'fulltime' | 'parttime' | 'internship' | 'contract' | undefined,
              limit,
              source: 'jobspy',
              skipCache,
              datePosted: datePosted === 'all' ? undefined : datePosted,
              // No location = global search (LinkedIn searches globally, Indeed uses country_indeed default)
            }, priority);
            logger.info('Scheduler', `  Found ${jobs.length} remote jobs globally for "${title}"${jobTypeLabel}`);
            allRawJobs.push(...jobs);
            queriesCompleted++;
            await onProgress?.(queriesCompleted, queriesTotal, `Collected ${allRawJobs.length} jobs`);
          } catch (error) {
            queriesFailed++;
            const errorMsg = error instanceof Error ? error.message : String(error);
            errors.push({ query: title, jobType, error: errorMsg });
            logger.error('Scheduler', `  Failed to collect remote jobs globally for "${title}"${jobTypeLabel}`, error);
          }
        }

        // Search for country-specific remote jobs (e.g., "Remote in Canada")
        for (const loc of countrySpecificRemote) {
          const variants = loc.searchVariants.slice(0, 2);
          if (variants.length === 0) variants.push(loc.country);

          for (const variant of variants) {
            queriesTotal++;
            try {
              logger.info('Scheduler', `  Collecting remote jobs for: "${title}" in "${variant}"${jobTypeLabel}`);
              const jobs = await queueService.enqueueCollection({
                query: title,
                location: variant,
                isRemote: true, // Remote jobs within this country
                jobType: jobType as 'fulltime' | 'parttime' | 'internship' | 'contract' | undefined,
                limit,
                source: 'jobspy',
                skipCache,
                datePosted: datePosted === 'all' ? undefined : datePosted,
              }, priority);
              logger.info('Scheduler', `  Found ${jobs.length} remote jobs for "${title}" in "${variant}"${jobTypeLabel}`);
              allRawJobs.push(...jobs);
              queriesCompleted++;
              await onProgress?.(queriesCompleted, queriesTotal, `Collected ${allRawJobs.length} jobs`);
            } catch (error) {
              queriesFailed++;
              const errorMsg = error instanceof Error ? error.message : String(error);
              errors.push({ query: title, location: variant, jobType, error: errorMsg });
              logger.error('Scheduler', `  Failed to collect remote jobs for "${title}" in "${variant}"${jobTypeLabel}`, error);
            }
          }
        }

        // Search for each physical location using up to 2 searchVariants
        for (const loc of physicalLocations) {
          const variants = loc.searchVariants.slice(0, 2);
          if (variants.length === 0) variants.push(loc.display);

          for (const variant of variants) {
            queriesTotal++;
            try {
              logger.info('Scheduler', `  Collecting jobs for: "${title}" in "${variant}"${jobTypeLabel}`);
              const jobs = await queueService.enqueueCollection({
                query: title,
                location: variant,
                isRemote: false, // Physical locations only
                jobType: jobType as 'fulltime' | 'parttime' | 'internship' | 'contract' | undefined,
                limit,
                source: 'jobspy',
                skipCache,
                datePosted: datePosted === 'all' ? undefined : datePosted,
              }, priority);
              logger.info('Scheduler', `  Found ${jobs.length} jobs for "${title}" in "${variant}"${jobTypeLabel}`);
              allRawJobs.push(...jobs);
              queriesCompleted++;
              await onProgress?.(queriesCompleted, queriesTotal, `Collected ${allRawJobs.length} jobs`);
            } catch (error) {
              queriesFailed++;
              const errorMsg = error instanceof Error ? error.message : String(error);
              errors.push({ query: title, location: variant, jobType, error: errorMsg });
              logger.error('Scheduler', `  Failed to collect jobs for "${title}" in "${variant}"${jobTypeLabel}`, error);
            }
          }
        }
      }
    }
  } else {
    // Legacy mode: single location (or no location = global search)
    for (const jobType of jobTypesToSearch) {
      const jobTypeLabel = jobType ? ` (${jobType})` : '';

      for (const title of jobTitles) {
        queriesTotal++;
        try {
          logger.info('Scheduler', `  Collecting jobs for: "${title}"${jobTypeLabel}`);
          const jobs = await queueService.enqueueCollection({
            query: title,
            location: legacyLocation ?? undefined, // undefined = global search
            isRemote: legacyIsRemote,
            jobType: jobType as 'fulltime' | 'parttime' | 'internship' | 'contract' | undefined,
            limit,
            source: 'jobspy',
            skipCache,
            datePosted: datePosted === 'all' ? undefined : datePosted,
          }, priority);
          logger.info('Scheduler', `  Found ${jobs.length} jobs for "${title}"${jobTypeLabel}`);
          allRawJobs.push(...jobs);
          queriesCompleted++;
          await onProgress?.(queriesCompleted, queriesTotal, `Collected ${allRawJobs.length} jobs`);
        } catch (error) {
          queriesFailed++;
          const errorMsg = error instanceof Error ? error.message : String(error);
          errors.push({ query: title, location: legacyLocation ?? undefined, jobType, error: errorMsg });
          logger.error('Scheduler', `  Failed to collect jobs for "${title}"${jobTypeLabel}`, error);
        }
      }
    }
  }

  return {
    jobs: allRawJobs,
    queriesTotal,
    queriesFailed,
    errors,
  };
}

/**
 * Filter jobs by location using normalized locations or legacy location.
 */
function filterJobsByLocation(
  jobs: NormalizedJob[],
  normalizedLocations: NormalizedLocation[] | null,
  legacyLocation: string | null
): NormalizedJob[] {
  // If normalizedLocations exists (even if empty), use the new system
  // Empty array means "Anywhere" - no filtering
  if (normalizedLocations !== null) {
    if (normalizedLocations.length === 0) {
      // User selected "Anywhere" - no location filter
      return jobs;
    }

    return jobs.filter(job =>
      LocationNormalizerAgent.matchesJob(normalizedLocations, {
        location: job.location,
        isRemote: job.isRemote,
      })
    );
  }

  // Legacy location filter (only for old subscriptions without normalizedLocations)
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

// Run search for a single subscription (used for immediate scan, initial run, or scheduled)
export async function runSingleSubscriptionSearch(
  subscriptionId: string,
  triggerType: TriggerType = 'manual'
): Promise<SingleSearchResult> {
  const db = getDb();

  // Start tracking the run
  const runId = await RunTracker.start(subscriptionId, triggerType);

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

  // Create subscription-scoped logger if debug mode is enabled
  const subLogger = createSubscriptionLogger(subscriptionId, sub.debugMode);

  if (sub.debugMode) {
    subLogger.info('Debug', '=== DEBUG MODE ENABLED - Detailed logging active ===');
    subLogger.debug('Debug', 'Subscription configuration', {
      id: sub.id,
      userId: sub.userId,
      jobTitles: sub.jobTitles,
      minScore: sub.minScore,
      datePosted: sub.datePosted,
      jobTypes: sub.jobTypes,
      excludedTitles: sub.excludedTitles,
      excludedCompanies: sub.excludedCompanies,
      isRemote: sub.isRemote,
      location: sub.location,
      normalizedLocations: sub.normalizedLocations,
    });
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

  // Capitalize trigger type for logs (manual -> Manual, scheduled -> Scheduled, initial -> Initial)
  const triggerLabel = formatTriggerLabel(triggerType);

  logger.info('Scheduler', `[${triggerLabel}] Scanning for ${userLabel}: ${sub.jobTitles.join(', ')}`);

  // Track current context for error reporting
  let errorContext: ErrorContext = {
    stage: 'collection',
    partialResults: { jobsCollected: 0, jobsNormalized: 0, jobsMatched: 0 },
  };

  try {
  // Parse normalized locations from JSON field
  const normalizedLocations = sub.normalizedLocations as NormalizedLocation[] | null;
  const datePosted = (sub.datePosted || 'month') as DatePostedType;

  // Extract job types from subscription
  const jobTypes = (sub.jobTypes ?? []) as string[];

  // Estimate query count for initial progress allocation
  // (titles × locations × jobTypes, or just titles if no specific locations/types)
  const locationCount = normalizedLocations?.length || (sub.location ? 1 : 1);
  const jobTypeCount = jobTypes.length || 1;
  const estimatedQueryCount = sub.jobTitles.length * locationCount * jobTypeCount;

  // Create progress calculator with initial estimate (will recalculate after collection)
  const progress = new ProgressCalculator(estimatedQueryCount, 100); // Assume ~100 jobs initially

  // Stage 1: Collection (dynamic % based on job count)
  errorContext.stage = 'collection';
  errorContext.query = sub.jobTitles.join(', ');
  errorContext.location = sub.location ?? (normalizedLocations ? LocationNormalizerAgent.formatForDisplaySingleLine(normalizedLocations) : undefined);

  const stageStartTime = Date.now();
  logger.info('Scheduler', `[${triggerLabel}] >>> STAGE: collection - Starting for ${sub.jobTitles.length} job titles`);

  await RunTracker.updateProgress(runId, {
    stage: 'collection',
    percent: 1,
    detail: `Starting collection for ${sub.jobTitles.length} job titles`,
  });

  subLogger.debug('Collection', 'Starting collection stage');
  const collectionResult = await collectJobsForSubscription({
    jobTitles: sub.jobTitles,
    normalizedLocations,
    legacyLocation: sub.location,
    legacyIsRemote: sub.isRemote,
    jobTypes,
    datePosted,
    limit: 1000, // Per-query limit for manual scans
    skipCache: true, // Manual scans always fetch fresh results
    priority: PRIORITY.MANUAL_SCAN,
    subLogger,
    onProgress: async (current, total, detail) => {
      const percent = progress.collection(current, total);
      await RunTracker.updateProgress(runId, {
        stage: 'collection',
        percent,
        detail,
        checkpoint: { stage: 'collection', queriesCompleted: current, queriesTotal: total },
      });
    },
  });

  const allRawJobs = collectionResult.jobs;

  // Check for collection failure - if ALL queries failed and we got 0 jobs, fail the run
  if (collectionResult.queriesFailed > 0 && allRawJobs.length === 0) {
    const errorMsg = `Collection failed: ${collectionResult.queriesFailed}/${collectionResult.queriesTotal} queries failed with 0 jobs collected`;
    errorContext.collectionErrors = collectionResult.errors;
    throw new Error(errorMsg);
  }

  errorContext.partialResults!.jobsCollected = allRawJobs.length;
  const collectionDuration = ((Date.now() - stageStartTime) / 1000).toFixed(1);
  logger.info('Scheduler', `[${triggerLabel}] <<< STAGE: collection - Completed in ${collectionDuration}s: ${allRawJobs.length} jobs (${collectionResult.queriesFailed}/${collectionResult.queriesTotal} queries failed)`);
  subLogger.debug('Collection', `Collection complete: ${allRawJobs.length} raw jobs, ${collectionResult.queriesFailed} failed queries`);

  // Recalculate progress allocations now that we know actual job count
  // This adjusts phase percentages so remaining time estimate is accurate
  progress.recalculate(collectionResult.queriesTotal, allRawJobs.length);
  subLogger.debug('Progress', `Recalculated progress allocations for ${allRawJobs.length} jobs`, progress.getAllocations());

  // Stage 2: Normalization (dynamic % based on job count)
  errorContext.stage = 'normalization';
  const normalizationStartTime = Date.now();
  logger.info('Scheduler', `[${triggerLabel}] >>> STAGE: normalization - Deduplicating ${allRawJobs.length} jobs`);

  await RunTracker.updateProgress(runId, {
    stage: 'normalization',
    percent: progress.normalizationStart(),
    detail: `Deduplicating ${allRawJobs.length} jobs`,
  });

  subLogger.debug('Normalization', 'Starting normalization and deduplication');
  let normalizedJobs = await normalizer.execute(allRawJobs);
  errorContext.partialResults!.jobsNormalized = normalizedJobs.length;
  logger.info('Scheduler', `[${triggerLabel}] After dedup: ${normalizedJobs.length} unique jobs`);
  subLogger.debug('Normalization', `Deduplication complete: ${normalizedJobs.length} unique jobs (removed ${allRawJobs.length - normalizedJobs.length} duplicates)`);

  // Apply exclusion filters
  const excludedTitles = sub.excludedTitles ?? [];
  const excludedCompanies = sub.excludedCompanies ?? [];

  if (excludedTitles.length > 0 || excludedCompanies.length > 0) {
    const beforeExclusionFilter = normalizedJobs.length;
    normalizedJobs = normalizedJobs.filter((job) => {
      const titleLower = job.title.toLowerCase();
      for (const excluded of excludedTitles) {
        if (titleLower.includes(excluded.toLowerCase())) {
          subLogger.debug('Filter', `Excluded job by title: "${job.title}" matches excluded term "${excluded}"`);
          return false;
        }
      }
      const companyLower = job.company.toLowerCase();
      for (const excluded of excludedCompanies) {
        if (companyLower.includes(excluded.toLowerCase())) {
          subLogger.debug('Filter', `Excluded job by company: "${job.company}" matches excluded term "${excluded}"`);
          return false;
        }
      }
      return true;
    });
    subLogger.debug('Filter', `Exclusion filter: removed ${beforeExclusionFilter - normalizedJobs.length} jobs`);
  }

  // Apply location filter using normalized locations or legacy location
  const beforeLocationFilter = normalizedJobs.length;
  normalizedJobs = filterJobsByLocation(normalizedJobs, normalizedLocations, sub.location);
  const locationFiltered = beforeLocationFilter - normalizedJobs.length;
  if (locationFiltered > 0) {
    logger.info('Scheduler', `[${triggerLabel}] Filtered ${locationFiltered} jobs by location`);
    subLogger.debug('Filter', `Location filter: removed ${locationFiltered} jobs that didn't match location criteria`);
  }

  const normalizationDuration = ((Date.now() - normalizationStartTime) / 1000).toFixed(1);
  logger.info('Scheduler', `[${triggerLabel}] <<< STAGE: normalization - Completed in ${normalizationDuration}s: ${normalizedJobs.length} jobs after filters`);
  subLogger.debug('Filter', `After all filters: ${normalizedJobs.length} jobs ready for matching`);

  // Stage 3: Matching (dynamic % based on job count - usually the largest phase)
  errorContext.stage = 'matching';
  const matchingStartTime = Date.now();
  logger.info('Scheduler', `[${triggerLabel}] >>> STAGE: matching - Processing ${normalizedJobs.length} jobs`);

  const newMatches: MatchItem[] = [];
  const stats: MatchStats = { skippedAlreadySent: 0, skippedBelowScore: 0, skippedCrossSubDuplicates: 0, previouslyMatchedOther: 0 };

  await RunTracker.updateProgress(runId, {
    stage: 'matching',
    percent: progress.normalizationEnd(),
    detail: `Starting matching for ${normalizedJobs.length} jobs`,
  });

  subLogger.debug('Matching', `Starting matching stage for ${normalizedJobs.length} jobs`);
  let matchedCount = 0;
  let matchingErrors = 0;
  const totalJobsToMatch = normalizedJobs.length;

  for (let jobIndex = 0; jobIndex < normalizedJobs.length; jobIndex++) {
    const job = normalizedJobs[jobIndex];
    // Update context for each job being matched
    errorContext.jobTitle = job.title;
    errorContext.company = job.company;

    try {
      subLogger.debug('Matching', `Processing job: "${job.title}" at "${job.company}"`, {
        location: job.location,
        isRemote: job.isRemote,
        contentHash: job.contentHash.slice(0, 8),
      });

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
        subLogger.debug('Matching', `Cache HIT for "${job.title}": score=${matchResult.score}`);
      } else {
        // Log BEFORE calling LLM so we know which job is being processed if it hangs
        logger.info('Scheduler', `[${triggerLabel}] Matching job ${jobIndex + 1}/${totalJobsToMatch}: "${job.title}" @ ${job.company} (desc: ${job.description?.length || 0} chars)`);
        subLogger.debug('Matching', `Cache MISS for "${job.title}" - calling LLM matcher`);
        matchResult = await matcher.execute({ job, resumeText: sub.resumeText });
        subLogger.debug('Matching', `LLM match result for "${job.title}": score=${matchResult.score}`, {
          matchedSkills: matchResult.matchedSkills?.slice(0, 5),
          missingSkills: matchResult.missingSkills?.slice(0, 5),
        });

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

      matchedCount++;

      // Update progress every 5 jobs or on last job (BEFORE filters so progress always updates)
      if ((jobIndex + 1) % 5 === 0 || jobIndex === totalJobsToMatch - 1) {
        const percent = progress.matching(jobIndex + 1, totalJobsToMatch);
        // Full checkpoint for resumption - includes all data needed to continue after restart
        const checkpoint: MatchingCheckpoint = {
          stage: 'matching',
          normalizedJobs,  // Store full job list for resumption
          currentIndex: jobIndex,
          matchedJobIds: newMatches.map(m => m.matchId),
          processedHashes: normalizedJobs.slice(0, jobIndex + 1).map(j => j.contentHash),
          stats: { ...stats },
          failedJobHashes: [],  // TODO: track failed jobs
        };
        await RunTracker.updateProgress(runId, {
          stage: 'matching',
          percent,
          detail: `Matched ${jobIndex + 1}/${totalJobsToMatch} jobs (${newMatches.length} new matches)`,
          checkpoint: checkpoint as Record<string, unknown>,
        });
      }

      // Track stats and apply filters
      if (matchResult.score < sub.minScore) {
        stats.skippedBelowScore++;
        subLogger.debug('Matching', `SKIP "${job.title}": score ${matchResult.score} below minScore ${sub.minScore}`);
        continue;
      }
      if (thisSentIds.has(jobMatchId)) {
        stats.skippedAlreadySent++;
        subLogger.debug('Matching', `SKIP "${job.title}": already sent to user`);
        continue;
      }
      const isPreviouslyMatched = otherSentIds.has(jobMatchId);
      if (isPreviouslyMatched && skipDupes) {
        stats.skippedCrossSubDuplicates++;
        subLogger.debug('Matching', `SKIP "${job.title}": cross-subscription duplicate`);
        continue;
      }
      if (isPreviouslyMatched) stats.previouslyMatchedOther++;

      newMatches.push({ job, match: matchResult, matchId: jobMatchId, isPreviouslyMatched });
      errorContext.partialResults!.jobsMatched = newMatches.length;
      subLogger.debug('Matching', `MATCH "${job.title}": score=${matchResult.score}, added to results`);
    } catch (error) {
      matchingErrors++;
      logger.error('Scheduler', `[${triggerLabel}] Failed to process job: ${job.title}`, error);
      subLogger.debug('Matching', `ERROR processing "${job.title}"`, error);
      // Continue to next job (intentional - partial results OK)
    }
  }

  const matchingDuration = ((Date.now() - matchingStartTime) / 1000).toFixed(1);
  logger.info('Scheduler', `[${triggerLabel}] <<< STAGE: matching - Completed in ${matchingDuration}s: ${newMatches.length} new matches, ${matchingErrors} errors`);
  subLogger.debug('Matching', `Matching complete: processed ${matchedCount} jobs, found ${newMatches.length} new matches, ${matchingErrors} errors`);

  // Clear job-specific context after matching loop
  delete errorContext.jobTitle;
  delete errorContext.company;

  // Update run stats mid-execution with error tracking
  await RunTracker.update(runId, {
    jobsCollected: allRawJobs.length,
    jobsAfterDedup: normalizedJobs.length,
    jobsMatched: newMatches.length,
    collectionQueriesTotal: collectionResult.queriesTotal,
    collectionQueriesFailed: collectionResult.queriesFailed,
    matchingJobsTotal: totalJobsToMatch,
    matchingJobsFailed: matchingErrors,
  });

  let notificationsSent = 0;

  if (newMatches.length > 0) {
    // Stage 4: Notification (final phase)
    errorContext.stage = 'notification';
    const notificationStartTime = Date.now();
    logger.info('Scheduler', `[${triggerLabel}] >>> STAGE: notification - Sending ${newMatches.length} notifications`);

    await RunTracker.updateProgress(runId, {
      stage: 'notification',
      percent: progress.notificationStart(),
      detail: `Sending ${newMatches.length} notifications`,
    });

    newMatches.sort((a, b) => b.match.score - a.match.score);

    subLogger.debug('Notification', `Sending ${newMatches.length} notifications to chat ${sub.user.chatId}`);
    subLogger.debug('Notification', 'Top matches being sent', {
      topMatches: newMatches.slice(0, 5).map(m => ({
        title: m.job.title,
        company: m.job.company,
        score: m.match.score,
      })),
    });

    // Build subscription context for notification header
    const subscriptionContext: SubscriptionContext = {
      jobTitles: sub.jobTitles,
      location: normalizedLocations
        ? LocationNormalizerAgent.formatForDisplaySingleLine(normalizedLocations)
        : sub.location,
      isRemote: sub.isRemote,
    };

    await sendMatchSummary(sub.user.chatId, newMatches, stats, subscriptionContext);

    // Use createMany with skipDuplicates to handle concurrent runs safely
    const created = await db.sentNotification.createMany({
      data: newMatches.map(({ matchId }) => ({
        subscriptionId: sub.id,
        jobMatchId: matchId,
      })),
      skipDuplicates: true,
    });

    notificationsSent = created.count;
    const notificationDuration = ((Date.now() - notificationStartTime) / 1000).toFixed(1);
    logger.info('Scheduler', `[${triggerLabel}] <<< STAGE: notification - Completed in ${notificationDuration}s: ${notificationsSent} notifications sent`);
    subLogger.debug('Notification', `Notification stage complete: ${notificationsSent} notifications recorded`);
  } else {
    logger.info('Scheduler', `[${triggerLabel}] <<< STAGE: notification - Skipped (no new matches)`);
    subLogger.debug('Notification', 'No new matches to send');
  }

  // Collect skill data for analytics
  const allMatchedSkills = newMatches.flatMap(m => m.match.matchedSkills ?? []);
  const allMissingSkills = newMatches.flatMap(m => m.match.missingSkills ?? []);
  if (allMatchedSkills.length > 0 || allMissingSkills.length > 0) {
    await updateSkillStats(subscriptionId, allMatchedSkills, allMissingSkills);
    subLogger.debug('Analytics', 'Updated skill stats', {
      matchedSkillsCount: allMatchedSkills.length,
      missingSkillsCount: allMissingSkills.length,
    });
  }

  // Create market snapshot for analytics
  if (normalizedJobs.length > 0) {
    await createMarketSnapshot(sub.jobTitles, sub.location, sub.isRemote, normalizedJobs);
    subLogger.debug('Analytics', 'Created market snapshot');
  }

  // Update last search timestamp
  await db.searchSubscription.update({
    where: { id: sub.id },
    data: { lastSearchAt: new Date() },
  });

  // Complete the run tracking with error stats
  await RunTracker.complete(runId, {
    jobsCollected: allRawJobs.length,
    jobsAfterDedup: normalizedJobs.length,
    jobsMatched: newMatches.length,
    notificationsSent,
    collectionQueriesTotal: collectionResult.queriesTotal,
    collectionQueriesFailed: collectionResult.queriesFailed,
    matchingJobsTotal: totalJobsToMatch,
    matchingJobsFailed: matchingErrors,
  });

  logger.info('Scheduler', `[${triggerLabel}] Results: ${newMatches.length} new | ${stats.skippedAlreadySent} already sent | ${stats.skippedBelowScore} below threshold | ${stats.skippedCrossSubDuplicates} cross-sub skipped`);

  // Final debug summary
  subLogger.debug('Complete', '=== RUN COMPLETE ===', {
    runId,
    jobsCollected: allRawJobs.length,
    jobsAfterDedup: normalizedJobs.length,
    newMatches: newMatches.length,
    notificationsSent,
    stats,
  });

  if (sub.debugMode) {
    subLogger.info('Debug', '=== DEBUG MODE - Run complete. Disable debug mode in admin dashboard when done. ===');
  }

  return { matchesFound: newMatches.length, notificationsSent, stats, jobsProcessed: normalizedJobs.length };

  } catch (error) {
    // Capture additional debug info before failing
    errorContext.subscriptionId = subscriptionId;
    errorContext.userId = sub.userId;
    errorContext.username = sub.user.username ?? undefined;
    errorContext.jobTitles = sub.jobTitles;
    errorContext.minScore = sub.minScore;
    errorContext.datePosted = sub.datePosted;
    errorContext.triggerType = triggerType;
    errorContext.timestamp = new Date().toISOString();

    await RunTracker.fail(runId, error, errorContext);
    throw error;
  }
}

export async function runSubscriptionSearches(): Promise<SearchResult> {
  const db = getDb();

  // Get all active, non-paused subscriptions (include debugMode for logging)
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
      // Create subscription-scoped logger for debug mode
      const subLogger = createSubscriptionLogger(sub.id, sub.debugMode);

      const userLabel = sub.user.username
        ? `@${sub.user.username}`
        : `user-${sub.user.telegramId}`;

      logger.info('Scheduler', `Processing ${userLabel}: ${sub.jobTitles.join(', ')}`);

      if (sub.debugMode) {
        subLogger.info('Debug', '=== DEBUG MODE ENABLED - Detailed logging active (scheduled run) ===');
        subLogger.debug('Debug', 'Subscription configuration', {
          id: sub.id,
          userId: sub.userId,
          jobTitles: sub.jobTitles,
          minScore: sub.minScore,
          datePosted: sub.datePosted,
          jobTypes: sub.jobTypes,
          excludedTitles: sub.excludedTitles,
          excludedCompanies: sub.excludedCompanies,
          isRemote: sub.isRemote,
          location: sub.location,
          normalizedLocations: sub.normalizedLocations,
        });
      }

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

      // Extract job types from subscription
      const jobTypes = (sub.jobTypes ?? []) as string[];

      // Estimate query count for progress allocation
      const locationCount = normalizedLocations?.length || (sub.location ? 1 : 1);
      const jobTypeCount = jobTypes.length || 1;
      const estimatedQueryCount = sub.jobTitles.length * locationCount * jobTypeCount;

      // Create progress calculator (will recalculate after collection when we know job count)
      const progress = new ProgressCalculator(estimatedQueryCount, 100);

      // Stage 1: Collection (dynamic % based on job count)
      errorContext.stage = 'collection';

      // First run: use user's configured datePosted to backfill historical jobs
      // Subsequent runs: use 'today' since older jobs were already processed
      const isFirstRun = !sub.lastSearchAt;
      const effectiveDatePosted = isFirstRun ? datePosted : 'today';
      const effectiveLimit = isFirstRun ? 1000 : 500;

      if (isFirstRun) {
        logger.info('Scheduler', `  First run - using user's datePosted: ${datePosted}`);
      }

      await RunTracker.updateProgress(runId, {
        stage: 'collection',
        percent: 1,
        detail: `Starting collection for ${sub.jobTitles.length} job titles`,
      });

      subLogger.debug('Collection', 'Starting collection stage');
      const collectionResult = await collectJobsForSubscription({
        jobTitles: sub.jobTitles,
        normalizedLocations,
        legacyLocation: sub.location,
        legacyIsRemote: sub.isRemote,
        jobTypes,
        datePosted: effectiveDatePosted,
        limit: effectiveLimit,
        skipCache: false,
        priority: PRIORITY.SCHEDULED,
        subLogger,
        onProgress: async (current, total, detail) => {
          const percent = progress.collection(current, total);
          await RunTracker.updateProgress(runId, {
            stage: 'collection',
            percent,
            detail,
            checkpoint: { stage: 'collection', queriesCompleted: current, queriesTotal: total },
          });
        },
      });

      const allRawJobs = collectionResult.jobs;

      // Check for collection failure - if ALL queries failed and we got 0 jobs, fail the run
      if (collectionResult.queriesFailed > 0 && allRawJobs.length === 0) {
        const errorMsg = `Collection failed: ${collectionResult.queriesFailed}/${collectionResult.queriesTotal} queries failed with 0 jobs collected`;
        errorContext.collectionErrors = collectionResult.errors;
        throw new Error(errorMsg);
      }

      errorContext.partialResults!.jobsCollected = allRawJobs.length;
      logger.info('Scheduler', `  Total collected: ${allRawJobs.length} raw jobs (${collectionResult.queriesFailed}/${collectionResult.queriesTotal} queries failed)`);
      subLogger.debug('Collection', `Collection complete: ${allRawJobs.length} raw jobs, ${collectionResult.queriesFailed} failed queries`);

      // Recalculate progress allocations now that we know actual job count
      progress.recalculate(collectionResult.queriesTotal, allRawJobs.length);
      subLogger.debug('Progress', `Recalculated progress allocations for ${allRawJobs.length} jobs`, progress.getAllocations());

      // Stage 2: Normalization (dynamic % based on job count)
      errorContext.stage = 'normalization';
      await RunTracker.updateProgress(runId, {
        stage: 'normalization',
        percent: progress.normalizationStart(),
        detail: `Deduplicating ${allRawJobs.length} jobs`,
      });

      subLogger.debug('Normalization', 'Starting normalization and deduplication');
      let normalizedJobs = await normalizer.execute(allRawJobs);
      errorContext.partialResults!.jobsNormalized = normalizedJobs.length;
      logger.debug('Scheduler', `  ${normalizedJobs.length} unique jobs after dedup`);
      subLogger.debug('Normalization', `Deduplication complete: ${normalizedJobs.length} unique jobs (removed ${allRawJobs.length - normalizedJobs.length} duplicates)`);

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
              subLogger.debug('Filter', `Excluded job by title: "${job.title}" matches excluded term "${excluded}"`);
              return false;
            }
          }
          // Check excluded companies (case-insensitive partial match)
          const companyLower = job.company.toLowerCase();
          for (const excluded of excludedCompanies) {
            if (companyLower.includes(excluded.toLowerCase())) {
              subLogger.debug('Filter', `Excluded job by company: "${job.company}" matches excluded term "${excluded}"`);
              return false;
            }
          }
          return true;
        });
        const filtered = beforeFilter - normalizedJobs.length;
        if (filtered > 0) {
          logger.debug('Scheduler', `  Filtered ${filtered} jobs by exclusions`);
        }
        subLogger.debug('Filter', `Exclusion filter: removed ${filtered} jobs`);
      }

      // Step 2.6: Apply location filter using normalized locations or legacy location
      const beforeLocationFilter = normalizedJobs.length;
      normalizedJobs = filterJobsByLocation(normalizedJobs, normalizedLocations, sub.location);
      const locationFiltered = beforeLocationFilter - normalizedJobs.length;
      if (locationFiltered > 0) {
        logger.info('Scheduler', `  Filtered ${locationFiltered} jobs by location`);
        subLogger.debug('Filter', `Location filter: removed ${locationFiltered} jobs that didn't match location criteria`);
      }

      subLogger.debug('Filter', `After all filters: ${normalizedJobs.length} jobs ready for matching`);

      // Stage 3: Matching (dynamic % based on job count - usually the largest phase)
      errorContext.stage = 'matching';
      const newMatches: MatchItem[] = [];
      const stats: MatchStats = { skippedAlreadySent: 0, skippedBelowScore: 0, skippedCrossSubDuplicates: 0, previouslyMatchedOther: 0 };

      await RunTracker.updateProgress(runId, {
        stage: 'matching',
        percent: progress.normalizationEnd(),
        detail: `Starting matching for ${normalizedJobs.length} jobs`,
      });

      subLogger.debug('Matching', `Starting matching stage for ${normalizedJobs.length} jobs`);
      let matchedCount = 0;
      let matchingErrors = 0;
      const totalJobsToMatch = normalizedJobs.length;

      for (let jobIndex = 0; jobIndex < normalizedJobs.length; jobIndex++) {
        const job = normalizedJobs[jobIndex];
        errorContext.jobTitle = job.title;
        errorContext.company = job.company;

        try {
          subLogger.debug('Matching', `Processing job: "${job.title}" at "${job.company}"`, {
            location: job.location,
            isRemote: job.isRemote,
            contentHash: job.contentHash.slice(0, 8),
          });

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
            subLogger.debug('Matching', `Cache HIT for "${job.title}": score=${matchResult.score}`);
          } else {
            // Need to create new match via LLM
            // Log BEFORE calling LLM so we know which job is being processed if it hangs
            logger.info('Scheduler', `  Matching job ${jobIndex + 1}/${totalJobsToMatch}: "${job.title}" @ ${job.company} (desc: ${job.description?.length || 0} chars)`);
            subLogger.debug('Matching', `Cache MISS for "${job.title}" - calling LLM matcher`);
            matchResult = await matcher.execute({
              job,
              resumeText: sub.resumeText,
            });
            subLogger.debug('Matching', `LLM match result for "${job.title}": score=${matchResult.score}`, {
              matchedSkills: matchResult.matchedSkills?.slice(0, 5),
              missingSkills: matchResult.missingSkills?.slice(0, 5),
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

          matchedCount++;

          // Update progress every 5 jobs or on last job (BEFORE filters so progress always updates)
          if ((jobIndex + 1) % 5 === 0 || jobIndex === totalJobsToMatch - 1) {
            const percent = progress.matching(jobIndex + 1, totalJobsToMatch);
            // Full checkpoint for resumption - includes all data needed to continue after restart
            const checkpoint: MatchingCheckpoint = {
              stage: 'matching',
              normalizedJobs,  // Store full job list for resumption
              currentIndex: jobIndex,
              matchedJobIds: newMatches.map(m => m.matchId),
              processedHashes: normalizedJobs.slice(0, jobIndex + 1).map(j => j.contentHash),
              stats: { ...stats },
              failedJobHashes: [],  // TODO: track failed jobs
            };
            await RunTracker.updateProgress(runId, {
              stage: 'matching',
              percent,
              detail: `Matched ${jobIndex + 1}/${totalJobsToMatch} jobs (${newMatches.length} new matches)`,
              checkpoint,
            });
          }

          // Track stats and apply filters
          if (matchResult.score < sub.minScore) {
            stats.skippedBelowScore++;
            subLogger.debug('Matching', `SKIP "${job.title}": score ${matchResult.score} below minScore ${sub.minScore}`);
            continue;
          }
          if (thisSentIds.has(jobMatchId)) {
            stats.skippedAlreadySent++;
            subLogger.debug('Matching', `SKIP "${job.title}": already sent to user`);
            continue;
          }
          const isPreviouslyMatched = otherSentIds.has(jobMatchId);
          if (isPreviouslyMatched && skipDupes) {
            stats.skippedCrossSubDuplicates++;
            subLogger.debug('Matching', `SKIP "${job.title}": cross-subscription duplicate`);
            continue;
          }
          if (isPreviouslyMatched) stats.previouslyMatchedOther++;

          newMatches.push({ job, match: matchResult, matchId: jobMatchId, isPreviouslyMatched });
          errorContext.partialResults!.jobsMatched = newMatches.length;
          subLogger.debug('Matching', `MATCH "${job.title}": score=${matchResult.score}, added to results`);
        } catch (error) {
          matchingErrors++;
          logger.error('Scheduler', `  Failed to process job: ${job.title}`, error);
          subLogger.debug('Matching', `ERROR processing "${job.title}"`, error);
          // Continue to next job (intentional - partial results OK)
        }
      }

      subLogger.debug('Matching', `Matching complete: processed ${matchedCount} jobs, found ${newMatches.length} new matches, ${matchingErrors} errors`);

      // Clear job-specific context after matching loop
      delete errorContext.jobTitle;
      delete errorContext.company;

      logger.info('Scheduler', `  Results: ${newMatches.length} new | ${stats.skippedAlreadySent} already sent | ${stats.skippedBelowScore} below threshold | ${stats.skippedCrossSubDuplicates} cross-sub skipped`);
      totalMatchesFound += newMatches.length;

      let notificationsSent = 0;
      if (newMatches.length > 0) {
        // Stage 4: Notification (final phase)
        errorContext.stage = 'notification';
        await RunTracker.updateProgress(runId, {
          stage: 'notification',
          percent: progress.notificationStart(),
          detail: `Sending ${newMatches.length} notifications`,
        });

        newMatches.sort((a, b) => b.match.score - a.match.score);

        subLogger.debug('Notification', `Sending ${newMatches.length} notifications to chat ${sub.user.chatId}`);
        subLogger.debug('Notification', 'Top matches being sent', {
          topMatches: newMatches.slice(0, 5).map(m => ({
            title: m.job.title,
            company: m.job.company,
            score: m.match.score,
          })),
        });

        // Build subscription context for notification header
        const subscriptionContext: SubscriptionContext = {
          jobTitles: sub.jobTitles,
          location: normalizedLocations
            ? LocationNormalizerAgent.formatForDisplaySingleLine(normalizedLocations)
            : sub.location,
          isRemote: sub.isRemote,
        };

        try {
          await sendMatchSummary(sub.user.chatId, newMatches, stats, subscriptionContext);

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
          subLogger.debug('Notification', `Notification stage complete: ${notificationsSent} notifications recorded`);
        } catch (error) {
          logger.error('Scheduler', `  Failed to send notifications to ${userLabel}`, error);
          subLogger.debug('Notification', `ERROR sending notifications`, error);
        }
      } else {
        subLogger.debug('Notification', 'No new matches to send');
      }

      // Collect skill data for analytics
      const allMatchedSkills = newMatches.flatMap(m => m.match.matchedSkills ?? []);
      const allMissingSkills = newMatches.flatMap(m => m.match.missingSkills ?? []);
      if (allMatchedSkills.length > 0 || allMissingSkills.length > 0) {
        await updateSkillStats(sub.id, allMatchedSkills, allMissingSkills);
        subLogger.debug('Analytics', 'Updated skill stats', {
          matchedSkillsCount: allMatchedSkills.length,
          missingSkillsCount: allMissingSkills.length,
        });
      }

      // Create market snapshot for analytics
      if (normalizedJobs.length > 0) {
        await createMarketSnapshot(sub.jobTitles, sub.location, sub.isRemote, normalizedJobs);
        subLogger.debug('Analytics', 'Created market snapshot');
      }

      // Update last search timestamp
      await db.searchSubscription.update({
        where: { id: sub.id },
        data: { lastSearchAt: new Date() },
      });

      // Complete the run tracking with error stats
      await RunTracker.complete(runId, {
        jobsCollected: allRawJobs.length,
        jobsAfterDedup: normalizedJobs.length,
        jobsMatched: newMatches.length,
        notificationsSent,
        collectionQueriesTotal: collectionResult.queriesTotal,
        collectionQueriesFailed: collectionResult.queriesFailed,
        matchingJobsTotal: totalJobsToMatch,
        matchingJobsFailed: matchingErrors,
      });

      // Final debug summary
      subLogger.debug('Complete', '=== RUN COMPLETE ===', {
        runId,
        jobsCollected: allRawJobs.length,
        jobsAfterDedup: normalizedJobs.length,
        newMatches: newMatches.length,
        notificationsSent,
        stats,
      });

      if (sub.debugMode) {
        subLogger.info('Debug', '=== DEBUG MODE - Run complete. Disable debug mode in admin dashboard when done. ===');
      }
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

/**
 * Resume an interrupted run from its checkpoint.
 * Called when we detect a run that was interrupted by server restart.
 */
export async function resumeInterruptedRun(
  runId: string,
  subscriptionId: string,
  checkpoint: MatchingCheckpoint
): Promise<{ success: boolean; newMatches: number; error?: string }> {
  const db = getDb();

  logger.info('Scheduler', `[Resumed] Resuming run ${runId} from checkpoint (index: ${checkpoint.currentIndex}/${checkpoint.normalizedJobs.length})`);

  try {
    // Get subscription data
    const sub = await db.searchSubscription.findUnique({
      where: { id: subscriptionId },
      include: { user: true },
    });

    if (!sub || !sub.isActive) {
      logger.warn('Scheduler', `[Resumed] Subscription ${subscriptionId} not found or inactive`);
      await RunTracker.fail(runId, new Error('Subscription not found or inactive'));
      return { success: false, newMatches: 0, error: 'Subscription not found or inactive' };
    }

    const subLogger = createSubscriptionLogger(sub.id, sub.debugMode);

    subLogger.info('Resume', `Resuming from checkpoint at index ${checkpoint.currentIndex}`, {
      totalJobs: checkpoint.normalizedJobs.length,
      processedSoFar: checkpoint.currentIndex + 1,
      matchesSoFar: checkpoint.matchedJobIds.length,
    });

    // Restore state from checkpoint
    const normalizedJobs = checkpoint.normalizedJobs;
    const startIndex = checkpoint.currentIndex + 1;  // Start from next job
    const stats = { ...checkpoint.stats };
    const processedHashes = new Set(checkpoint.processedHashes);

    // Get IDs of notifications already sent to avoid duplicates
    const thisSentIds = new Set(
      (await db.sentNotification.findMany({
        where: { subscriptionId: sub.id },
        select: { jobMatchId: true },
      })).map(n => n.jobMatchId)
    );

    // Calculate progress for remaining work
    const totalJobsToMatch = normalizedJobs.length;
    const progress = new ProgressCalculator(1, totalJobsToMatch);
    progress.recalculate(1, totalJobsToMatch);

    const newMatches: MatchItem[] = [];
    let matchedCount = checkpoint.currentIndex + 1;
    let matchingErrors = 0;

    // Continue matching loop from checkpoint
    for (let jobIndex = startIndex; jobIndex < normalizedJobs.length; jobIndex++) {
      const job = normalizedJobs[jobIndex];

      try {
        subLogger.debug('Matching', `[Resumed] Processing job ${jobIndex + 1}/${totalJobsToMatch}: "${job.title}" at "${job.company}"`);

        // Check if already processed (shouldn't happen but safety check)
        if (processedHashes.has(job.contentHash)) {
          subLogger.debug('Matching', `SKIP "${job.title}": already processed in previous attempt`);
          continue;
        }

        // Check for existing match in DB
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
          subLogger.debug('Matching', `Cache HIT for "${job.title}": score=${matchResult.score}`);
        } else {
          // LLM call
          logger.info('Scheduler', `[Resumed] Matching job ${jobIndex + 1}/${totalJobsToMatch}: "${job.title}" @ ${job.company}`);
          matchResult = await matcher.execute({ job, resumeText: sub.resumeText });
          subLogger.debug('Matching', `LLM match result for "${job.title}": score=${matchResult.score}`);

          // Save to DB
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

        matchedCount++;

        // Update progress every 5 jobs
        if ((jobIndex + 1) % 5 === 0 || jobIndex === totalJobsToMatch - 1) {
          const percent = progress.matching(jobIndex + 1, totalJobsToMatch);
          const updatedCheckpoint: MatchingCheckpoint = {
            stage: 'matching',
            normalizedJobs,
            currentIndex: jobIndex,
            matchedJobIds: [...checkpoint.matchedJobIds, ...newMatches.map(m => m.matchId)],
            processedHashes: [...processedHashes, job.contentHash],
            stats: { ...stats },
            failedJobHashes: checkpoint.failedJobHashes,
          };
          await RunTracker.updateProgress(runId, {
            stage: 'matching',
            percent,
            detail: `Matched ${jobIndex + 1}/${totalJobsToMatch} jobs (${newMatches.length + checkpoint.matchedJobIds.length} new matches)`,
            checkpoint: updatedCheckpoint as Record<string, unknown>,
          });
        }

        // Apply filters
        if (matchResult.score < sub.minScore) {
          stats.skippedBelowScore++;
          continue;
        }
        if (thisSentIds.has(jobMatchId)) {
          stats.skippedAlreadySent++;
          continue;
        }

        newMatches.push({ job, match: matchResult, matchId: jobMatchId, isPreviouslyMatched: false });
        subLogger.debug('Matching', `MATCH "${job.title}": score=${matchResult.score}`);

      } catch (error) {
        matchingErrors++;
        logger.error('Scheduler', `[Resumed] Failed to process job: ${job.title}`, error);
      }
    }

    logger.info('Scheduler', `[Resumed] Matching complete: ${newMatches.length} new matches, ${matchingErrors} errors`);

    // Send notifications
    if (newMatches.length > 0) {
      const subContext: SubscriptionContext = {
        jobTitles: sub.jobTitles,
        location: sub.location,
        isRemote: sub.isRemote,
      };
      await sendMatchSummary(sub.user.chatId, newMatches, stats, subContext);
    }

    // Complete the run
    await RunTracker.complete(runId, {
      jobsCollected: normalizedJobs.length,
      jobsAfterDedup: normalizedJobs.length,
      jobsMatched: newMatches.length + checkpoint.matchedJobIds.length,
      notificationsSent: newMatches.length,
    });

    // Clear checkpoint on success (keep only summary)
    await db.subscriptionRun.update({
      where: { id: runId },
      data: { checkpoint: Prisma.DbNull },  // Clear large checkpoint data
    });

    logger.info('Scheduler', `[Resumed] Run ${runId} completed successfully`);
    return { success: true, newMatches: newMatches.length };

  } catch (error) {
    logger.error('Scheduler', `[Resumed] Failed to resume run ${runId}`, error);
    await RunTracker.fail(runId, error);
    return { success: false, newMatches: 0, error: String(error) };
  }
}
