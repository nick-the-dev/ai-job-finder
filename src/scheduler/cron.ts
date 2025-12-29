import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import { runSingleSubscriptionSearch } from './jobs/search-subscriptions.js';

let scheduledTask: cron.ScheduledTask | null = null;
let isProcessing = false;

// Check every minute for due subscriptions
const DUE_CHECK_SCHEDULE = '* * * * *';

// Max subscriptions to process per minute (prevents overwhelming the system)
const MAX_PER_MINUTE = 5;

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

      logger.info('Scheduler', `Processing subscription for ${userName} (${sub.jobTitles.join(', ')})`);

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

  logger.info(
    'Scheduler',
    `Initialized with staggered scheduling | Check: every minute | Interval: ${config.SUBSCRIPTION_INTERVAL_HOURS}h | Max/min: ${MAX_PER_MINUTE}`
  );
}

export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('Scheduler', 'Stopped');
  }
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
