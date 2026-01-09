import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { runSingleSubscriptionSearch } from './jobs/search-subscriptions.js';
import { getRedis, isRedisConnected } from '../queue/redis.js';
import { RunTracker } from '../observability/tracker.js';

let scheduledTask: cron.ScheduledTask | null = null;
let cleanupTask: cron.ScheduledTask | null = null;
let isProcessing = false;

// Check every minute for due subscriptions
const DUE_CHECK_SCHEDULE = '* * * * *';

// Cleanup stuck runs every 5 minutes
const CLEANUP_SCHEDULE = '*/5 * * * *';

// Max subscriptions to process per minute (prevents overwhelming the system)
const MAX_PER_MINUTE = 5;

// Runs stuck for longer than this are considered failed (ms)
// NOTE: This is only for crash recovery - runs that are ACTUALLY stuck due to server crash
// We do NOT auto-fail runs just because they take long - that would mask implementation bugs
const STUCK_RUN_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours - only for crash recovery

// Default lock TTL in seconds - must be MUCH longer than max expected run time
// Runs can take up to 1 hour, so we use 2 hours to be safe
const LOCK_TTL_SECONDS = 7200; // 2 hours

// Redis key prefix for subscription locks
const LOCK_KEY_PREFIX = 'lock:subscription:';

// Fallback in-memory Set when Redis is unavailable
const runningSubscriptionsLocal = new Set<string>();

/**
 * Acquire a distributed lock for a subscription using Redis.
 * Falls back to in-memory locking if Redis is unavailable.
 *
 * @param subscriptionId - The subscription ID to lock
 * @param ttlSeconds - Lock TTL in seconds (default: 600 = 10 minutes)
 * @returns true if lock acquired, false if already locked
 */
export async function acquireSubscriptionLock(
  subscriptionId: string,
  ttlSeconds: number = LOCK_TTL_SECONDS
): Promise<boolean> {
  const redis = getRedis();

  if (redis && isRedisConnected()) {
    try {
      const key = `${LOCK_KEY_PREFIX}${subscriptionId}`;
      // Use SET NX EX for atomic lock acquisition with TTL
      // Value includes PID and timestamp for debugging
      const lockValue = JSON.stringify({
        pid: process.pid,
        hostname: process.env.HOSTNAME || 'unknown',
        acquiredAt: new Date().toISOString(),
      });
      const result = await redis.set(key, lockValue, 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (error) {
      logger.warn('Scheduler', `Redis lock acquisition failed for ${subscriptionId}, falling back to local`, error);
      // Fall through to local lock
    }
  }

  // Fallback: in-memory lock (single instance only)
  if (runningSubscriptionsLocal.has(subscriptionId)) {
    return false;
  }
  runningSubscriptionsLocal.add(subscriptionId);
  return true;
}

/**
 * Release a distributed lock for a subscription.
 * Falls back to in-memory lock release if Redis is unavailable.
 *
 * @param subscriptionId - The subscription ID to unlock
 */
export async function releaseSubscriptionLock(subscriptionId: string): Promise<void> {
  const redis = getRedis();

  if (redis && isRedisConnected()) {
    try {
      const key = `${LOCK_KEY_PREFIX}${subscriptionId}`;
      await redis.del(key);
    } catch (error) {
      logger.warn('Scheduler', `Redis lock release failed for ${subscriptionId}`, error);
      // Continue - lock will expire anyway
    }
  }

  // Always clean up local tracking as well
  runningSubscriptionsLocal.delete(subscriptionId);
}

/**
 * Check if a subscription is currently being processed.
 * Checks both Redis and local tracking.
 */
export async function isSubscriptionRunning(subscriptionId: string): Promise<boolean> {
  const redis = getRedis();

  if (redis && isRedisConnected()) {
    try {
      const key = `${LOCK_KEY_PREFIX}${subscriptionId}`;
      const exists = await redis.exists(key);
      return exists === 1;
    } catch (error) {
      logger.warn('Scheduler', `Redis lock check failed for ${subscriptionId}, checking local`, error);
      // Fall through to local check
    }
  }

  // Fallback: check local tracking
  return runningSubscriptionsLocal.has(subscriptionId);
}

/**
 * Synchronous check for subscription running status (local only).
 * Use this when async check is not possible.
 */
export function isSubscriptionRunningSync(subscriptionId: string): boolean {
  return runningSubscriptionsLocal.has(subscriptionId);
}

/**
 * Mark subscription as running (for external callers like manual scans)
 * Async version that uses Redis when available.
 */
export async function markSubscriptionRunning(subscriptionId: string): Promise<boolean> {
  return acquireSubscriptionLock(subscriptionId);
}

/**
 * Mark subscription as finished.
 * Async version that releases Redis lock when available.
 */
export async function markSubscriptionFinished(subscriptionId: string): Promise<void> {
  await releaseSubscriptionLock(subscriptionId);
}

/**
 * Cleanup stuck runs - fail any runs that have been "running" for too long
 */
async function cleanupStuckRuns(): Promise<void> {
  const db = getDb();
  const threshold = new Date(Date.now() - STUCK_RUN_THRESHOLD);

  try {
    const stuckRuns = await db.subscriptionRun.findMany({
      where: {
        status: 'running',
        startedAt: { lt: threshold },
      },
      select: {
        id: true,
        subscriptionId: true,
        startedAt: true,
      },
    });

    if (stuckRuns.length === 0) {
      return;
    }

    logger.warn('Scheduler', `Found ${stuckRuns.length} stuck run(s), marking as failed`);

    for (const run of stuckRuns) {
      const durationMs = Date.now() - run.startedAt.getTime();

      await db.subscriptionRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          completedAt: new Date(),
          durationMs,
          errorMessage: `Run timed out after ${Math.round(durationMs / 1000 / 60)} minutes (auto-cleanup)`,
        },
      });

      // Clear lock (both Redis and local)
      await releaseSubscriptionLock(run.subscriptionId);

      logger.info('Scheduler', `Marked stuck run ${run.id} as failed (was running for ${Math.round(durationMs / 1000 / 60)}m)`);
    }
  } catch (error) {
    logger.error('Scheduler', 'Failed to cleanup stuck runs', error);
  }
}

/**
 * Check for subscriptions that are due to run
 * - nextRunAt is null (never run before, newly created)
 * - nextRunAt <= now (past due)
 */
async function checkDueSubscriptions(): Promise<void> {
  // Prevent overlapping runs
  if (isProcessing) {
    logger.debug('Scheduler', 'Previous check still running, skipping');
    return;
  }

  isProcessing = true;
  const db = getDb();

  try {
    const now = new Date();

    // Find due subscriptions
    const dueSubscriptions = await db.searchSubscription.findMany({
      where: {
        isActive: true,
        isPaused: false,
        OR: [
          { nextRunAt: null },           // Never run before
          { nextRunAt: { lte: now } },   // Past due
        ],
      },
      take: MAX_PER_MINUTE,
      orderBy: [
        { nextRunAt: 'asc' },  // Oldest first (null comes first in asc order)
      ],
      include: {
        user: {
          select: { firstName: true, username: true },
        },
      },
    });

    if (dueSubscriptions.length === 0) {
      return; // Nothing to do
    }

    logger.info('Scheduler', `Found ${dueSubscriptions.length} due subscription(s)`);

    for (const sub of dueSubscriptions) {
      const userName = sub.user?.firstName || sub.user?.username || 'Unknown';
      const subIdShort = sub.id.slice(0, 8);

      logger.info('Scheduler', `[${subIdShort}] >>> Attempting lock for ${userName} (${sub.jobTitles.join(', ')})`);

      // Acquire lock FIRST (prevents concurrent runs across instances)
      const lockAcquired = await acquireSubscriptionLock(sub.id);
      if (!lockAcquired) {
        logger.warn('Scheduler', `[${subIdShort}] LOCK FAILED for ${userName} - subscription already running (locked)`);
        continue;
      }

      logger.info('Scheduler', `[${subIdShort}] LOCK ACQUIRED for ${userName}`);

      // Only update nextRunAt AFTER lock is acquired to prevent being stuck if lock fails
      await db.searchSubscription.update({
        where: { id: sub.id },
        data: { nextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }, // 24 hours
      });

      logger.info('Scheduler', `[${subIdShort}] >>> RUN START for ${userName} (${sub.jobTitles.join(', ')})`);

      const startTime = Date.now();

      try {
        // No timeout wrapper - if a run takes long, we need visibility into WHY
        // rather than masking it with auto-failure. The enhanced logging will show progress.
        const result = await runSingleSubscriptionSearch(sub.id, 'scheduled');

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // Success: schedule next run at normal interval
        const nextRunAt = new Date(Date.now() + config.SUBSCRIPTION_INTERVAL_HOURS * 60 * 60 * 1000);
        await db.searchSubscription.update({
          where: { id: sub.id },
          data: {
            lastSearchAt: new Date(),
            nextRunAt,
          },
        });

        logger.info(
          'Scheduler',
          `[${subIdShort}] <<< RUN COMPLETE for ${userName} in ${duration}s | ${result.matchesFound} matches | ${result.notificationsSent} notifications | Next run: ${nextRunAt.toISOString()}`
        );
      } catch (error) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        const errorMsg = error instanceof Error ? error.message : String(error);

        logger.error('Scheduler', `[${subIdShort}] <<< RUN FAILED for ${userName} after ${duration}s: ${errorMsg}`, error);

        // Failure: schedule retry in 5 minutes (shorter than normal interval)
        const retryDelay = 5 * 60 * 1000; // 5 minutes
        const retryAt = new Date(Date.now() + retryDelay);
        await db.searchSubscription.update({
          where: { id: sub.id },
          data: { nextRunAt: retryAt },
        });

        logger.info('Scheduler', `[${subIdShort}] Scheduled retry for ${userName} at ${retryAt.toISOString()}`);
      } finally {
        await releaseSubscriptionLock(sub.id);
        logger.info('Scheduler', `[${subIdShort}] LOCK RELEASED for ${userName}`);
      }
    }
  } catch (error) {
    logger.error('Scheduler', 'Due check failed', error);
  } finally {
    isProcessing = false;
  }
}

/**
 * Handle interrupted runs on startup.
 * This function:
 * 1. Fails any stale runs (older than 24 hours)
 * 2. Finds recent interrupted runs with checkpoint data
 * 3. Finds runs stuck without checkpoint (stuck at "Starting collection")
 * 4. Marks them as failed with a descriptive message
 * 5. Releases their locks so they can re-run on next schedule
 * 6. Schedules an immediate re-run for the subscription
 *
 * This is called on startup to ensure no runs are permanently stuck.
 */
export async function handleInterruptedRuns(): Promise<void> {
  const db = getDb();

  try {
    // Step 1: Fail any very old stale runs
    const staleCount = await RunTracker.failStaleRuns(24);
    if (staleCount > 0) {
      logger.info('Scheduler', `Cleaned up ${staleCount} stale run(s) on startup`);
    }

    // Step 2: Find recent interrupted runs WITH checkpoint (within last hour)
    const interruptedRuns = await RunTracker.findInterruptedRuns();

    // Step 3: Find runs stuck WITHOUT checkpoint (running > 10 min with no checkpoint)
    const stuckRuns = await RunTracker.findStuckRunsWithoutCheckpoint(10);

    // Combine both sets
    const allStuckRuns = [...interruptedRuns, ...stuckRuns];

    if (allStuckRuns.length === 0) {
      logger.debug('Scheduler', 'No interrupted/stuck runs to handle');
      return;
    }

    logger.info('Scheduler', `Found ${interruptedRuns.length} interrupted + ${stuckRuns.length} stuck runs from previous instance`);

    for (const run of allStuckRuns) {
      const checkpoint = run.checkpoint as Record<string, unknown> | null;
      const stage = run.currentStage || 'unknown';
      const percent = run.progressPercent || 0;
      const username = run.subscription.user?.username || 'unknown';
      const hasCheckpoint = checkpoint !== null;

      // Calculate how long it was running before interruption
      const durationMs = Date.now() - run.startedAt.getTime();
      const durationMin = Math.round(durationMs / 1000 / 60);

      // Log what was interrupted
      const runType = hasCheckpoint ? 'Interrupted' : 'Stuck (no checkpoint)';
      logger.info(
        'Scheduler',
        `${runType} run ${run.id} for @${username}: stage=${stage}, progress=${percent}%, duration=${durationMin}min`
      );

      // Mark the run as failed with descriptive message
      const errorMessage = hasCheckpoint
        ? `Run interrupted by server restart at ${stage} stage (${percent}% complete)`
        : `Run stuck at ${stage} stage for ${durationMin} minutes (no progress, likely blocked on queue)`;

      await db.subscriptionRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          completedAt: new Date(),
          durationMs,
          errorMessage,
          failedStage: stage,
          // Preserve checkpoint in errorContext for debugging
          errorContext: JSON.parse(JSON.stringify({
            reason: hasCheckpoint ? 'server_restart' : 'stuck_no_progress',
            interruptedAt: new Date().toISOString(),
            stage,
            percent,
            checkpoint,
            progressDetail: run.progressDetail,
          })),
        },
      });

      // Release the lock so subscription can run again
      await releaseSubscriptionLock(run.subscriptionId);

      // Schedule immediate re-run by setting nextRunAt to now
      // This ensures the subscription runs on the next scheduler check
      await db.searchSubscription.update({
        where: { id: run.subscriptionId },
        data: { nextRunAt: new Date() },
      });

      logger.info(
        'Scheduler',
        `Marked ${runType.toLowerCase()} run ${run.id} as failed and scheduled immediate re-run for @${username}`
      );
    }

    logger.info('Scheduler', `Handled ${allStuckRuns.length} interrupted/stuck run(s) - they will re-run shortly`);
  } catch (error) {
    logger.error('Scheduler', 'Failed to handle interrupted runs', error);
  }
}

export function initScheduler(): void {
  if (scheduledTask) {
    logger.warn('Scheduler', 'Scheduler already initialized');
    return;
  }

  scheduledTask = cron.schedule(DUE_CHECK_SCHEDULE, checkDueSubscriptions);
  cleanupTask = cron.schedule(CLEANUP_SCHEDULE, cleanupStuckRuns);

  // Run cleanup immediately on startup to clear any stuck runs from previous crashes
  cleanupStuckRuns();

  logger.info(
    'Scheduler',
    `Initialized with staggered scheduling | Check: every minute | Interval: ${config.SUBSCRIPTION_INTERVAL_HOURS}h | Max/min: ${MAX_PER_MINUTE} | Cleanup: every 5min`
  );
}

export async function stopScheduler(): Promise<void> {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  if (cleanupTask) {
    cleanupTask.stop();
    cleanupTask = null;
  }
  runningSubscriptionsLocal.clear();
  logger.info('Scheduler', 'Stopped');
}

/**
 * Manual trigger for testing - runs all active subscriptions
 * @deprecated Use individual subscription triggers via Telegram instead
 */
export async function triggerSearchNow(): Promise<{
  usersProcessed: number;
  matchesFound: number;
  notificationsSent: number;
}> {
  logger.info('Scheduler', '=== Manual trigger: Processing all due subscriptions ===');

  const db = getDb();
  const subscriptions = await db.searchSubscription.findMany({
    where: { isActive: true, isPaused: false },
    select: { id: true },
  });

  let totalMatches = 0;
  let totalNotifications = 0;

  for (const sub of subscriptions) {
    try {
      const result = await runSingleSubscriptionSearch(sub.id, 'manual');
      totalMatches += result.matchesFound;
      totalNotifications += result.notificationsSent;
    } catch (error) {
      logger.error('Scheduler', `Manual trigger failed for subscription ${sub.id}`, error);
    }
  }

  logger.info(
    'Scheduler',
    `=== Manual trigger completed | ${subscriptions.length} users | ${totalMatches} matches | ${totalNotifications} notifications ===`
  );

  return {
    usersProcessed: subscriptions.length,
    matchesFound: totalMatches,
    notificationsSent: totalNotifications,
  };
}
