import Queue, { Job } from 'bull';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { isRedisConnected } from './redis.js';
import type { RawJob, JobMatchResult } from '../core/types.js';

// Job priority levels (lower = higher priority)
export const PRIORITY = {
  MANUAL_SCAN: 1,    // User-initiated Telegram scans
  API_REQUEST: 2,    // API /search calls
  SCHEDULED: 3,      // Scheduled subscription searches
} as const;

export type Priority = typeof PRIORITY[keyof typeof PRIORITY];

// Job data types
export interface CollectionJobData {
  query: string;
  location?: string;
  isRemote?: boolean;
  limit: number;
  source: 'jobspy' | 'serpapi';
  skipCache: boolean;
  datePosted?: 'today' | '3days' | 'week' | 'month';
  requestId: string;
  priority: Priority;
}

export interface MatchingJobData {
  job: {
    contentHash: string;
    title: string;
    company: string;
    description: string;
    location?: string;
    isRemote?: boolean;
    salaryMin?: number;
    salaryMax?: number;
    salaryCurrency?: string;
    applicationUrl?: string;
    postedDate?: string;
    source: string;
    sourceId?: string;
  };
  resumeText: string;
  resumeHash: string;
  requestId: string;
  priority: Priority;
}

// Queue instances
let collectionQueue: Queue.Queue<CollectionJobData> | null = null;
let matchingQueue: Queue.Queue<MatchingJobData> | null = null;

export function getQueues() {
  return { collectionQueue, matchingQueue };
}

export async function initQueues(): Promise<boolean> {
  if (!isRedisConnected()) {
    logger.warn('Queue', 'Redis not available - queues disabled');
    return false;
  }

  const redisOptions = {
    redis: config.REDIS_URL,
    settings: {
      stalledInterval: 30000,    // Check for stalled jobs every 30s
      maxStalledCount: 2,        // Retry stalled jobs up to 2 times
    },
  };

  try {
    collectionQueue = new Queue<CollectionJobData>('job-collection', redisOptions);
    matchingQueue = new Queue<MatchingJobData>('job-matching', redisOptions);

    // Configure error handlers
    collectionQueue.on('error', (err: Error) => {
      logger.error('Queue', 'Collection queue error', err);
    });

    matchingQueue.on('error', (err: Error) => {
      logger.error('Queue', 'Matching queue error', err);
    });

    // Log job completion
    collectionQueue.on('completed', (job: Job<CollectionJobData>, result: RawJob[]) => {
      const jobCount = Array.isArray(result) ? result.length : 0;
      logger.debug('Queue', `Collection job ${job.id} completed: ${jobCount} jobs`);
    });

    matchingQueue.on('completed', (job: Job<MatchingJobData>, result: { match: JobMatchResult; cached: boolean }) => {
      const cached = result?.cached ? ' (cached)' : '';
      logger.debug('Queue', `Matching job ${job.id} completed${cached}`);
    });

    // Log failed jobs
    collectionQueue.on('failed', (job: Job<CollectionJobData> | undefined, err: Error) => {
      logger.error('Queue', `Collection job ${job?.id} failed`, err);
    });

    matchingQueue.on('failed', (job: Job<MatchingJobData> | undefined, err: Error) => {
      logger.error('Queue', `Matching job ${job?.id} failed`, err);
    });

    logger.info('Queue', 'All queues initialized');
    return true;
  } catch (error) {
    logger.error('Queue', 'Failed to initialize queues', error);
    return false;
  }
}

export async function closeQueues(): Promise<void> {
  const closePromises: Promise<void>[] = [];

  if (collectionQueue) {
    closePromises.push(collectionQueue.close().catch(() => {}));
    collectionQueue = null;
  }

  if (matchingQueue) {
    closePromises.push(matchingQueue.close().catch(() => {}));
    matchingQueue = null;
  }

  await Promise.all(closePromises);
  logger.info('Queue', 'All queues closed');
}

export async function getQueueStatus(): Promise<{
  collection: Queue.JobCounts | null;
  matching: Queue.JobCounts | null;
}> {
  const [collectionCounts, matchingCounts] = await Promise.all([
    collectionQueue?.getJobCounts() ?? null,
    matchingQueue?.getJobCounts() ?? null,
  ]);

  return {
    collection: collectionCounts,
    matching: matchingCounts,
  };
}
