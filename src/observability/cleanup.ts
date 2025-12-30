import cron from 'node-cron';
import { getDb } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

let cleanupTask: cron.ScheduledTask | null = null;

/**
 * Clean up old observability data based on retention settings
 */
export async function cleanupOldData(): Promise<{
  runsDeleted: number;
  metricsDeleted: number;
}> {
  const db = getDb();
  const retentionDays = config.OBSERVABILITY_RETENTION_DAYS ?? 30;

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  // Delete old subscription runs
  const runsResult = await db.subscriptionRun.deleteMany({
    where: { startedAt: { lt: cutoffDate } },
  });

  // Delete old market snapshots (keep for 90 days)
  const snapshotCutoff = new Date();
  snapshotCutoff.setDate(snapshotCutoff.getDate() - 90);

  const snapshotsResult = await db.marketSnapshot.deleteMany({
    where: { date: { lt: snapshotCutoff } },
  });

  // Note: SkillStats are kept indefinitely (small, valuable for long-term insights)

  logger.info(
    'Cleanup',
    `Deleted ${runsResult.count} old runs, ${snapshotsResult.count} old snapshots (retention: ${retentionDays} days)`
  );

  return {
    runsDeleted: runsResult.count,
    metricsDeleted: snapshotsResult.count,
  };
}

/**
 * Start the cleanup scheduler (runs daily at 3 AM)
 */
export function startCleanupScheduler(): void {
  if (cleanupTask) {
    logger.warn('Cleanup', 'Scheduler already running');
    return;
  }

  // Run at 3 AM daily
  cleanupTask = cron.schedule('0 3 * * *', async () => {
    try {
      await cleanupOldData();
    } catch (error) {
      logger.error('Cleanup', 'Scheduled cleanup failed', error);
    }
  });

  const retentionDays = config.OBSERVABILITY_RETENTION_DAYS ?? 30;
  logger.info('Cleanup', `Scheduler started (retention: ${retentionDays} days, runs daily at 3 AM)`);
}

/**
 * Stop the cleanup scheduler
 */
export function stopCleanupScheduler(): void {
  if (cleanupTask) {
    cleanupTask.stop();
    cleanupTask = null;
    logger.info('Cleanup', 'Scheduler stopped');
  }
}
