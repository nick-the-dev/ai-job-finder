import { Prisma } from '@prisma/client';
import { getDb } from '../db/client.js';
import { logger } from '../utils/logger.js';

export type TriggerType = 'scheduled' | 'manual' | 'initial' | 'resumed';
export type RunStatus = 'running' | 'completed' | 'failed';
export type RunStage = 'collection' | 'normalization' | 'matching' | 'notification' | 'completed';

/**
 * Format trigger type for display in logs
 * Capitalizes first letter: 'scheduled' -> 'Scheduled'
 */
export function formatTriggerLabel(triggerType: TriggerType): string {
  return triggerType.charAt(0).toUpperCase() + triggerType.slice(1);
}

export interface RunStats {
  jobsCollected?: number;
  jobsAfterDedup?: number;
  jobsMatched?: number;
  notificationsSent?: number;
  // Granular error tracking
  collectionQueriesTotal?: number;
  collectionQueriesFailed?: number;
  matchingJobsTotal?: number;
  matchingJobsFailed?: number;
}

export interface ProgressUpdate {
  stage: RunStage;
  percent: number;
  detail?: string;
  checkpoint?: Record<string, unknown>;
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
        collectionQueriesTotal: stats.collectionQueriesTotal,
        collectionQueriesFailed: stats.collectionQueriesFailed,
        matchingJobsTotal: stats.matchingJobsTotal,
        matchingJobsFailed: stats.matchingJobsFailed,
      },
    });
  }

  /**
   * Update progress for real-time visibility
   * Call this throughout the run to show exact stage and %
   */
  static async updateProgress(runId: string, progress: ProgressUpdate): Promise<void> {
    const db = getDb();

    try {
      await db.subscriptionRun.update({
        where: { id: runId },
        data: {
          currentStage: progress.stage,
          progressPercent: progress.percent,
          progressDetail: progress.detail,
          checkpoint: progress.checkpoint ? JSON.parse(JSON.stringify(progress.checkpoint)) : undefined,
        },
      });
    } catch (error) {
      // Don't fail the run if progress update fails
      logger.warn('RunTracker', `Failed to update progress for run ${runId}: ${error}`);
    }
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
        // Error tracking
        collectionQueriesTotal: stats.collectionQueriesTotal ?? run.collectionQueriesTotal,
        collectionQueriesFailed: stats.collectionQueriesFailed ?? run.collectionQueriesFailed,
        matchingJobsTotal: stats.matchingJobsTotal ?? run.matchingJobsTotal,
        matchingJobsFailed: stats.matchingJobsFailed ?? run.matchingJobsFailed,
        // Clear progress (run is done)
        currentStage: 'completed',
        progressPercent: 100,
        progressDetail: null,
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

  /**
   * Find interrupted runs that can be resumed after restart
   * Returns runs that were 'running' within the last hour and have checkpoint data
   */
  static async findInterruptedRuns() {
    const db = getDb();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    return db.subscriptionRun.findMany({
      where: {
        status: 'running',
        checkpoint: { not: Prisma.DbNull },
        startedAt: { gte: oneHourAgo },
      },
      include: {
        subscription: {
          include: {
            user: {
              select: { username: true, chatId: true },
            },
          },
        },
      },
      orderBy: { startedAt: 'desc' },
    });
  }

  /**
   * Find runs that are stuck without a checkpoint (early failure)
   * These runs got stuck before saving any checkpoint data and should be failed
   * @param minAgeMinutes - Only return runs older than this (default: 10 minutes)
   */
  static async findStuckRunsWithoutCheckpoint(minAgeMinutes: number = 10) {
    const db = getDb();
    const cutoff = new Date(Date.now() - minAgeMinutes * 60 * 1000);

    return db.subscriptionRun.findMany({
      where: {
        status: 'running',
        checkpoint: { equals: Prisma.DbNull },
        startedAt: { lt: cutoff },
      },
      include: {
        subscription: {
          include: {
            user: {
              select: { username: true, chatId: true },
            },
          },
        },
      },
      orderBy: { startedAt: 'desc' },
    });
  }

  /**
   * Get currently active (running) runs
   * Used by admin dashboard for live progress display
   */
  static async getActiveRuns() {
    const db = getDb();

    return db.subscriptionRun.findMany({
      where: { status: 'running' },
      include: {
        subscription: {
          select: {
            jobTitles: true,
            user: {
              select: { username: true, firstName: true },
            },
          },
        },
      },
      orderBy: { startedAt: 'desc' },
    });
  }

  /**
   * Mark all stale running runs as failed
   * Called on startup to clean up runs that were interrupted without checkpoint
   */
  static async failStaleRuns(maxAgeHours: number = 24): Promise<number> {
    const db = getDb();
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);

    const result = await db.subscriptionRun.updateMany({
      where: {
        status: 'running',
        startedAt: { lt: cutoff },
      },
      data: {
        status: 'failed',
        completedAt: new Date(),
        errorMessage: 'Run exceeded maximum duration - marked as stale',
        failedStage: 'unknown',
      },
    });

    if (result.count > 0) {
      logger.info('RunTracker', `Marked ${result.count} stale runs as failed`);
    }

    return result.count;
  }
}
