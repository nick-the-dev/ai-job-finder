import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { runSubscriptionSearches } from './jobs/search-subscriptions.js';

let scheduledTask: cron.ScheduledTask | null = null;

// Default: every hour at minute 0
const DEFAULT_SCHEDULE = '0 * * * *';

export function initScheduler(): void {
  if (scheduledTask) {
    logger.warn('Scheduler', 'Scheduler already initialized');
    return;
  }

  scheduledTask = cron.schedule(DEFAULT_SCHEDULE, async () => {
    logger.info('Scheduler', '=== Starting hourly subscription search ===');
    const startTime = Date.now();

    try {
      const result = await runSubscriptionSearches();
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      logger.info(
        'Scheduler',
        `=== Completed in ${duration}s | ${result.usersProcessed} users | ${result.matchesFound} matches | ${result.notificationsSent} notifications ===`
      );
    } catch (error) {
      logger.error('Scheduler', 'Subscription search failed', error);
    }
  });

  logger.info('Scheduler', `Initialized with schedule: ${DEFAULT_SCHEDULE} (hourly)`);
}

export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info('Scheduler', 'Stopped');
  }
}

// Manual trigger for testing
export async function triggerSearchNow(): Promise<{
  usersProcessed: number;
  matchesFound: number;
  notificationsSent: number;
}> {
  logger.info('Scheduler', '=== Manual trigger: Starting subscription search ===');
  const startTime = Date.now();

  const result = await runSubscriptionSearches();
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  logger.info(
    'Scheduler',
    `=== Manual trigger completed in ${duration}s | ${result.usersProcessed} users | ${result.matchesFound} matches | ${result.notificationsSent} notifications ===`
  );

  return result;
}
