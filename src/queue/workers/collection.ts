import { Job } from 'bull';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { CollectorService } from '../../services/collector.js';
import { getQueues, type CollectionJobData } from '../queues.js';
import type { RawJob } from '../../core/types.js';

const collector = new CollectorService();

/**
 * Process a collection job from the queue
 */
export async function processCollectionJob(job: Job<CollectionJobData>): Promise<RawJob[]> {
  const { query, location, isRemote, jobType, limit, source, skipCache, datePosted, requestId } = job.data;

  const jobTypeLabel = jobType ? ` [${jobType}]` : '';
  logger.info('Worker:Collection', `[${requestId}] Processing: "${query}"${jobTypeLabel} (${source}, limit: ${limit})`);

  try {
    const jobs = await collector.execute({
      query,
      location,
      isRemote,
      jobType,
      limit,
      source,
      skipCache,
      datePosted,
    });

    logger.info('Worker:Collection', `[${requestId}] Collected ${jobs.length} jobs`);
    return jobs;
  } catch (error) {
    logger.error('Worker:Collection', `[${requestId}] Failed`, error);
    throw error;
  }
}

/**
 * Start the collection worker
 */
export function startCollectionWorker(): boolean {
  const { collectionQueue } = getQueues();

  if (!collectionQueue) {
    logger.warn('Worker:Collection', 'Queue not available - worker disabled');
    return false;
  }

  collectionQueue.process(config.QUEUE_JOBSPY_CONCURRENCY, processCollectionJob);
  logger.info('Worker:Collection', `Started with concurrency: ${config.QUEUE_JOBSPY_CONCURRENCY}`);
  return true;
}
