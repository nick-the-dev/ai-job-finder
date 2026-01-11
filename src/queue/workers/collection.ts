import { Job } from 'bull';
import * as Sentry from '@sentry/node';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { CollectorService } from '../../services/collector.js';
import { getQueues, type CollectionJobData } from '../queues.js';
import { isRunCancelled } from '../redis.js';
import { rateLimiter } from '../rate-limiter.js';
import type { RawJob } from '../../core/types.js';
import { addQueueBreadcrumb } from '../../utils/sentry.js';

const collector = new CollectorService();

// Track last job completion time for inter-job delays
let lastJobCompletionTime = 0;

/**
 * Process a collection job from the queue
 *
 * Includes smart rate limiting to avoid LinkedIn 429 errors:
 * - Waits for required delay based on source (LinkedIn needs longer delays)
 * - Tracks 429 errors and applies exponential backoff
 * - Enters cooldown mode after consecutive 429s
 */
export async function processCollectionJob(job: Job<CollectionJobData>): Promise<RawJob[]> {
  const { query, location, isRemote, jobType, limit, source, skipCache, datePosted, country, requestId, runId } = job.data;

  // Check if the run has been cancelled before doing any work
  if (runId && await isRunCancelled(runId)) {
    logger.info('Worker:Collection', `[${requestId}] Skipping job ${job.id} - run ${runId} was cancelled`);
    return []; // Return empty, don't waste resources
  }

  const jobTypeLabel = jobType ? ` [${jobType}]` : '';
  logger.info('Worker:Collection', `[${requestId}] >>> WORKER START (jobId=${job.id}): "${query}"${jobTypeLabel} @ ${location || 'any'} (${source}, limit: ${limit}, country: ${country || 'auto'})`);

  addQueueBreadcrumb('collection', 'process', { query, location, source, jobId: String(job.id) });

  // JobSpy uses LinkedIn as primary source, so use linkedin rate limiting
  const rateLimitSource = source === 'jobspy' ? 'linkedin' : source;

  // Wait for rate limit slot before processing
  // This is the key change - we now respect rate limits BEFORE making requests
  const preDelay = await rateLimiter.waitForSlot(rateLimitSource);
  if (preDelay > 0) {
    logger.info('Worker:Collection', `[${requestId}] Rate limit delay: waited ${Math.round(preDelay)}ms before starting`);
  }

  // Also ensure minimum delay between any collection jobs (global throttle)
  const now = Date.now();
  const timeSinceLastJob = now - lastJobCompletionTime;
  const minDelay = config.COLLECTION_MIN_DELAY_MS;
  if (lastJobCompletionTime > 0 && timeSinceLastJob < minDelay) {
    const waitTime = minDelay - timeSinceLastJob;
    logger.debug('Worker:Collection', `[${requestId}] Global throttle: waiting ${waitTime}ms`);
    await sleep(waitTime);
  }

  // Wrap entire collection job in a Sentry span for performance monitoring
  return Sentry.startSpan(
    {
      op: 'queue.process',
      name: `collection.${source}`,
      attributes: {
        'queue.name': 'collection',
        'job.id': String(job.id),
        'job.query': query,
        'job.location': location || 'any',
        'job.source': source,
        'job.limit': limit,
        'job.jobType': jobType || 'all',
      },
    },
    async () => {
      const workerStartTime = Date.now();

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
          country,
        });

        const collectDuration = Date.now() - collectStartTime;
        const totalDuration = Date.now() - workerStartTime;
        logger.info('Worker:Collection', `[${requestId}] <<< WORKER DONE (jobId=${job.id}): Collected ${jobs.length} jobs in ${collectDuration}ms (total: ${totalDuration}ms)`);

        // Record success with rate limiter
        rateLimiter.recordSuccess(rateLimitSource);
        lastJobCompletionTime = Date.now();

        addQueueBreadcrumb('collection', 'complete', { jobsCount: jobs.length, duration: totalDuration });
        return jobs;
      } catch (error) {
        const totalDuration = Date.now() - workerStartTime;
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check if this is a 429 rate limit error
        if (rateLimiter.is429Error(errorMessage)) {
          logger.warn('Worker:Collection', `[${requestId}] Rate limit (429) detected for ${rateLimitSource}`);
          rateLimiter.record429(rateLimitSource);
        } else {
          rateLimiter.recordError(rateLimitSource, errorMessage);
        }

        lastJobCompletionTime = Date.now();

        logger.error('Worker:Collection', `[${requestId}] <<< WORKER FAILED (jobId=${job.id}) after ${totalDuration}ms`, error);

        addQueueBreadcrumb('collection', 'fail', { duration: totalDuration, error: errorMessage });

        if (error instanceof Error) {
          Sentry.captureException(error, {
            tags: { component: 'worker', worker: 'collection', query, location: location || 'any' },
            extra: { requestId, jobId: job.id, source, duration: totalDuration },
          });
        }
        throw error;
      }
    }
  );
}

/**
 * Helper function to sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
