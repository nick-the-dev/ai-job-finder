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
  const workerStartTime = Date.now();

  const jobTypeLabel = jobType ? ` [${jobType}]` : '';
  logger.info('Worker:Collection', `[${requestId}] >>> WORKER START (jobId=${job.id}): "${query}"${jobTypeLabel} @ ${location || 'any'} (${source}, limit: ${limit})`);

  try {
    logger.info('Worker:Collection', `[${requestId}] Calling collector.execute()...`);
    const collectStartTime = Date.now();

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

    const collectDuration = Date.now() - collectStartTime;
    const totalDuration = Date.now() - workerStartTime;
    logger.info('Worker:Collection', `[${requestId}] <<< WORKER DONE (jobId=${job.id}): Collected ${jobs.length} jobs in ${collectDuration}ms (total: ${totalDuration}ms)`);
    return jobs;
  } catch (error) {
    const totalDuration = Date.now() - workerStartTime;
    logger.error('Worker:Collection', `[${requestId}] <<< WORKER FAILED (jobId=${job.id}) after ${totalDuration}ms`, error);
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
