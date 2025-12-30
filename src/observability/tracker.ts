import { getDb } from '../db/client.js';
import { logger } from '../utils/logger.js';

export type TriggerType = 'scheduled' | 'manual';
export type RunStatus = 'running' | 'completed' | 'failed';

export interface RunStats {
  jobsCollected?: number;
  jobsAfterDedup?: number;
  jobsMatched?: number;
  notificationsSent?: number;
}

export type FailedStage = 'collection' | 'normalization' | 'matching' | 'notification';

export interface ErrorContext {
  stage: FailedStage;
  query?: string;           // Which job title was being searched
  location?: string;        // Which location was being searched
  jobTitle?: string;        // Which job was being processed (for matching)
  company?: string;         // Which company (for matching)
  partialResults?: {        // What we got before failure
    jobsCollected?: number;
    jobsNormalized?: number;
    jobsMatched?: number;
  };
  queueJobId?: string;      // Bull queue job ID
  requestId?: string;       // Request correlation ID
  retryAttempt?: number;    // Which attempt this was
  [key: string]: unknown;   // Allow additional context
}

/**
 * Tracks subscription run execution for observability
 */
export class RunTracker {
  /**
   * Start tracking a new subscription run
   * @returns runId to use for updates
   */
  static async start(subscriptionId: string, triggerType: TriggerType): Promise<string> {
    const db = getDb();

    const run = await db.subscriptionRun.create({
      data: {
        subscriptionId,
        triggerType,
        status: 'running',
      },
    });

    logger.debug('RunTracker', `Started run ${run.id} for subscription ${subscriptionId} (${triggerType})`);
    return run.id;
  }

  /**
   * Update run stats mid-execution
   */
  static async update(runId: string, stats: RunStats): Promise<void> {
    const db = getDb();

    await db.subscriptionRun.update({
      where: { id: runId },
      data: {
        jobsCollected: stats.jobsCollected,
        jobsAfterDedup: stats.jobsAfterDedup,
        jobsMatched: stats.jobsMatched,
        notificationsSent: stats.notificationsSent,
      },
    });
  }

  /**
   * Mark run as completed with final stats
   */
  static async complete(runId: string, stats: RunStats): Promise<void> {
    const db = getDb();

    const run = await db.subscriptionRun.findUnique({
      where: { id: runId },
    });

    if (!run) {
      logger.warn('RunTracker', `Cannot complete run ${runId}: not found`);
      return;
    }

    const now = new Date();
    const durationMs = now.getTime() - run.startedAt.getTime();

    await db.subscriptionRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        completedAt: now,
        durationMs,
        jobsCollected: stats.jobsCollected ?? run.jobsCollected,
        jobsAfterDedup: stats.jobsAfterDedup ?? run.jobsAfterDedup,
        jobsMatched: stats.jobsMatched ?? run.jobsMatched,
        notificationsSent: stats.notificationsSent ?? run.notificationsSent,
      },
    });

    logger.debug('RunTracker', `Completed run ${runId} in ${durationMs}ms`);
  }

  /**
   * Mark run as failed with error details and context
   */
  static async fail(runId: string, error: unknown, context?: ErrorContext): Promise<void> {
    const db = getDb();

    const run = await db.subscriptionRun.findUnique({
      where: { id: runId },
    });

    if (!run) {
      logger.warn('RunTracker', `Cannot fail run ${runId}: not found`);
      return;
    }

    const now = new Date();
    const durationMs = now.getTime() - run.startedAt.getTime();

    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    await db.subscriptionRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        completedAt: now,
        durationMs,
        errorMessage,
        errorStack,
        failedStage: context?.stage,
        errorContext: context ? JSON.parse(JSON.stringify(context)) : undefined,
      },
    });

    // Log with context for immediate visibility
    const contextStr = context
      ? ` [stage: ${context.stage}${context.query ? `, query: "${context.query}"` : ''}${context.location ? `, location: "${context.location}"` : ''}]`
      : '';
    logger.error('RunTracker', `Failed run ${runId} after ${durationMs}ms${contextStr}: ${errorMessage}`);
  }

  /**
   * Get run by ID
   */
  static async getById(runId: string) {
    const db = getDb();
    return db.subscriptionRun.findUnique({
      where: { id: runId },
      include: {
        subscription: {
          include: {
            user: {
              select: { username: true, firstName: true, telegramId: true },
            },
          },
        },
      },
    });
  }

  /**
   * Get recent runs with optional filters
   */
  static async getRecent(options: {
    limit?: number;
    subscriptionId?: string;
    status?: RunStatus;
  } = {}) {
    const db = getDb();
    const { limit = 20, subscriptionId, status } = options;

    return db.subscriptionRun.findMany({
      where: {
        ...(subscriptionId && { subscriptionId }),
        ...(status && { status }),
      },
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: {
        subscription: {
          include: {
            user: {
              select: { username: true, firstName: true },
            },
          },
        },
      },
    });
  }

  /**
   * Get run stats for a subscription over a time period
   */
  static async getStats(subscriptionId: string, days: number = 7) {
    const db = getDb();
    const since = new Date();
    since.setDate(since.getDate() - days);

    const runs = await db.subscriptionRun.findMany({
      where: {
        subscriptionId,
        startedAt: { gte: since },
      },
      select: {
        status: true,
        jobsCollected: true,
        jobsMatched: true,
        notificationsSent: true,
        durationMs: true,
      },
    });

    const completed = runs.filter(r => r.status === 'completed');
    const failed = runs.filter(r => r.status === 'failed');

    return {
      totalRuns: runs.length,
      completedRuns: completed.length,
      failedRuns: failed.length,
      successRate: runs.length > 0 ? (completed.length / runs.length) * 100 : 0,
      totalJobsCollected: completed.reduce((sum, r) => sum + r.jobsCollected, 0),
      totalJobsMatched: completed.reduce((sum, r) => sum + r.jobsMatched, 0),
      totalNotificationsSent: completed.reduce((sum, r) => sum + r.notificationsSent, 0),
      avgDurationMs: completed.length > 0
        ? completed.reduce((sum, r) => sum + (r.durationMs || 0), 0) / completed.length
        : 0,
    };
  }
}
