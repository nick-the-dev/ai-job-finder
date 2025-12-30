import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { runSingleSubscriptionSearch } from './jobs/search-subscriptions.js';

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
const STUCK_RUN_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours

// Track currently running subscriptions to prevent concurrent runs
const runningSubscriptions = new Set<string>();

/**
 * Check if a subscription is currently being processed
 */
export function isSubscriptionRunning(subscriptionId: string): boolean {
  return runningSubscriptions.has(subscriptionId);
}

/**
 * Mark subscription as running (for external callers like manual scans)
 */
export function markSubscriptionRunning(subscriptionId: string): boolean {
  if (runningSubscriptions.has(subscriptionId)) {
    return false; // Already running
  }
  runningSubscriptions.add(subscriptionId);
  return true;
}

/**
 * Mark subscription as finished
 */
export function markSubscriptionFinished(subscriptionId: string): void {
  runningSubscriptions.delete(subscriptionId);
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

      // Clear from running set if present
      runningSubscriptions.delete(run.subscriptionId);

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

      // Calculate next run time BEFORE processing (to prevent re-processing on failure)
      const nextRunAt = new Date(now.getTime() + config.SUBSCRIPTION_INTERVAL_HOURS * 60 * 60 * 1000);

      // Update nextRunAt immediately to prevent re-selection
      await db.searchSubscription.update({
        where: { id: sub.id },
        data: { nextRunAt },
      });

      // Check if subscription is already running (prevents concurrent runs)
      if (runningSubscriptions.has(sub.id)) {
        logger.warn('Scheduler', `Skipping ${userName} - subscription already running`);
        continue;
      }

      logger.info('Scheduler', `Processing subscription for ${userName} (${sub.jobTitles.join(', ')})`);
      runningSubscriptions.add(sub.id);

      try {
        const startTime = Date.now();
        const result = await runSingleSubscriptionSearch(sub.id);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // Update lastSearchAt on success
        await db.searchSubscription.update({
          where: { id: sub.id },
          data: { lastSearchAt: new Date() },
        });

        logger.info(
          'Scheduler',
          `Completed for ${userName} in ${duration}s | ${result.matchesFound} matches | ${result.notificationsSent} notifications | Next run: ${nextRunAt.toISOString()}`
        );
      } catch (error) {
        logger.error('Scheduler', `Failed for ${userName}`, error);
        // nextRunAt already set, so it will retry next interval
      } finally {
        runningSubscriptions.delete(sub.id);
      }
    }
  } catch (error) {
    logger.error('Scheduler', 'Due check failed', error);
  } finally {
    isProcessing = false;
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

export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  if (cleanupTask) {
    cleanupTask.stop();
    cleanupTask = null;
  }
  runningSubscriptions.clear();
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
      const result = await runSingleSubscriptionSearch(sub.id);
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
