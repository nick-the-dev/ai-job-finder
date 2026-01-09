import crypto from 'crypto';
import pLimit from 'p-limit';
import { Job } from 'bull';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { isRedisConnected } from './redis.js';
import { getQueues, PRIORITY, type CollectionJobData, type MatchingJobData, type Priority } from './queues.js';
import type { RawJob, NormalizedJob, JobMatchResult } from '../core/types.js';

// Fallback rate limiters (used when Redis is down)
const fallbackJobspyLimit = pLimit(2);
const fallbackLlmLimit = pLimit(5);

// Timeouts for queue jobs (ms)
const COLLECTION_TIMEOUT = 3 * 60 * 1000; // 3 minutes per collection
const MATCHING_TIMEOUT = 60 * 1000; // 1 minute per match

// In-memory request deduplication cache
// Prevents duplicate API calls when multiple subscriptions request the same query
const REQUEST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache for in-flight dedup

interface CacheEntry {
  promise: Promise<RawJob[]>;
  timestamp: number;
}

const requestCache = new Map<string, CacheEntry>();

// Clean up old cache entries periodically
// Store interval ID to allow cleanup on shutdown
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

function startCacheCleanup(): void {
  if (cleanupIntervalId) return; // Already running
  cleanupIntervalId = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of requestCache.entries()) {
      if (now - entry.timestamp > REQUEST_CACHE_TTL) {
        requestCache.delete(key);
      }
    }
  }, 60 * 1000); // Clean every minute
  // Allow Node.js to exit cleanly when this is the only pending work
  cleanupIntervalId.unref();
}

function stopCacheCleanup(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
}

// Start cleanup on module load
startCacheCleanup();

/**
 * Generate cache key for collection request deduplication
 * Uses null for undefined values to match CollectorService behavior
 */
function getCollectionCacheKey(params: Omit<CollectionJobData, 'requestId' | 'priority'>): string {
  // Include all parameters that affect the API response
  // Use null for undefined to be consistent with CollectorService
  const keyData = {
    query: params.query,
    location: params.location ?? null,
    isRemote: params.isRemote ?? null,
    jobType: params.jobType ?? null,
    datePosted: params.datePosted ?? null,
    source: params.source ?? 'jobspy',
    limit: params.limit ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(keyData)).digest('hex').substring(0, 16);
}

/**
 * Wait for job completion with timeout
 */
async function waitWithTimeout<T>(job: Job<unknown>, timeoutMs: number): Promise<T> {
  return Promise.race([
    job.finished() as Promise<T>,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Job ${job.id} timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

// Generate short request IDs
function generateRequestId(): string {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * QueueService - unified interface for enqueueing jobs
 * Falls back to in-process rate limiting if Redis unavailable
 */
export class QueueService {
  /**
   * Enqueue a job collection request
   * Falls back to direct execution if Redis unavailable
   * Uses in-memory request deduplication to avoid duplicate API calls
   */
  async enqueueCollection(
    params: Omit<CollectionJobData, 'requestId' | 'priority'>,
    priority: Priority = PRIORITY.API_REQUEST
  ): Promise<RawJob[]> {
    const requestId = generateRequestId();
    const startTime = Date.now();
    logger.info('QueueService', `[${requestId}] >>> enqueueCollection START: "${params.query}" @ ${params.location || 'any'} (cache=${requestCache.size} entries)`);

    // Check in-memory request cache for deduplication (unless skipCache is true)
    if (!params.skipCache) {
      const cacheKey = getCollectionCacheKey(params);
      const cached = requestCache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < REQUEST_CACHE_TTL) {
        const cacheAge = Math.round((Date.now() - cached.timestamp) / 1000);
        logger.info('QueueService', `[${requestId}] CACHE HIT for "${params.query}" (key: ${cacheKey}, age: ${cacheAge}s) - waiting for existing promise...`);
        try {
          // Return a copy of the cached jobs to prevent mutation issues
          const cachedJobs = await cached.promise;
          logger.info('QueueService', `[${requestId}] CACHE RESOLVED for "${params.query}" with ${cachedJobs.length} jobs in ${Date.now() - startTime}ms`);
          return [...cachedJobs];
        } catch (cacheError) {
          logger.error('QueueService', `[${requestId}] CACHE PROMISE FAILED for "${params.query}" after ${Date.now() - startTime}ms`, cacheError);
          throw cacheError;
        }
      }

      logger.info('QueueService', `[${requestId}] CACHE MISS for "${params.query}" (key: ${cacheKey}) - creating new request`);

      // Create the actual request and cache it
      const requestPromise = this.executeCollection(params, requestId, priority);
      requestCache.set(cacheKey, {
        promise: requestPromise,
        timestamp: Date.now(),
      });

      try {
        const result = await requestPromise;
        logger.info('QueueService', `[${requestId}] <<< enqueueCollection DONE: "${params.query}" returned ${result.length} jobs in ${Date.now() - startTime}ms`);
        return result;
      } catch (error) {
        // Remove from cache on error so it can be retried
        requestCache.delete(cacheKey);
        logger.error('QueueService', `[${requestId}] <<< enqueueCollection FAILED: "${params.query}" after ${Date.now() - startTime}ms`, error);
        throw error;
      }
    }

    // skipCache=true: bypass request cache
    logger.info('QueueService', `[${requestId}] SKIP CACHE - executing directly`);
    const result = await this.executeCollection(params, requestId, priority);
    logger.info('QueueService', `[${requestId}] <<< enqueueCollection DONE (no cache): "${params.query}" returned ${result.length} jobs in ${Date.now() - startTime}ms`);
    return result;
  }

  /**
   * Internal method to execute collection (used by enqueueCollection)
   */
  private async executeCollection(
    params: Omit<CollectionJobData, 'requestId' | 'priority'>,
    requestId: string,
    priority: Priority
  ): Promise<RawJob[]> {
    const execStartTime = Date.now();
    const { collectionQueue } = getQueues();

    logger.info('QueueService', `[${requestId}] executeCollection: checking queue availability...`);

    if (!collectionQueue || !isRedisConnected()) {
      if (config.QUEUE_FALLBACK_ENABLED) {
        logger.info('QueueService', `[${requestId}] executeCollection: Redis unavailable, using FALLBACK`);
        return this.directCollection(params);
      }
      throw new Error('Queue unavailable and fallback disabled');
    }

    // Get queue stats for visibility
    const [waiting, active, completed, failed] = await Promise.all([
      collectionQueue.getWaitingCount(),
      collectionQueue.getActiveCount(),
      collectionQueue.getCompletedCount(),
      collectionQueue.getFailedCount(),
    ]);
    logger.info('QueueService', `[${requestId}] executeCollection: Queue stats - waiting=${waiting}, active=${active}, completed=${completed}, failed=${failed}`);

    logger.info('QueueService', `[${requestId}] executeCollection: Adding job to queue for "${params.query}"...`);
    const addStartTime = Date.now();

    const job = await collectionQueue.add(
      { ...params, requestId, priority },
      {
        priority,
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        timeout: COLLECTION_TIMEOUT, // Bull job timeout
      }
    );

    const jobId = job.id;
    logger.info('QueueService', `[${requestId}] executeCollection: Job added to queue (jobId=${jobId}) in ${Date.now() - addStartTime}ms, now waiting for result...`);

    try {
      // Set up a progress logger while waiting
      const progressInterval = setInterval(async () => {
        const jobState = await job.getState();
        const elapsed = Math.round((Date.now() - execStartTime) / 1000);
        logger.info('QueueService', `[${requestId}] executeCollection: WAITING for jobId=${jobId}, state=${jobState}, elapsed=${elapsed}s`);
      }, 10000); // Log every 10 seconds

      const result = await waitWithTimeout<RawJob[]>(job, COLLECTION_TIMEOUT);

      clearInterval(progressInterval);
      logger.info('QueueService', `[${requestId}] executeCollection: Job ${jobId} completed with ${result.length} jobs in ${Date.now() - execStartTime}ms`);
      return result;
    } catch (error) {
      // Log timeout errors with context for debugging
      const jobState = await job.getState().catch(() => 'unknown');
      if (error instanceof Error && error.message.includes('timed out')) {
        logger.error('QueueService', `[${requestId}] executeCollection: TIMEOUT for "${params.query}" (jobId=${jobId}, state=${jobState}, elapsed=${Date.now() - execStartTime}ms)`);
      } else {
        logger.error('QueueService', `[${requestId}] executeCollection: FAILED for "${params.query}" (jobId=${jobId}, state=${jobState})`, error);
      }
      throw error;
    }
  }

  /**
   * Enqueue a matching request
   * Falls back to direct execution if Redis unavailable
   */
  async enqueueMatching(
    job: NormalizedJob,
    resumeText: string,
    resumeHash: string,
    priority: Priority = PRIORITY.API_REQUEST
  ): Promise<{ match: JobMatchResult; cached: boolean; jobMatchId?: string }> {
    const requestId = generateRequestId();
    const { matchingQueue } = getQueues();

    if (!matchingQueue || !isRedisConnected()) {
      if (config.QUEUE_FALLBACK_ENABLED) {
        logger.debug('QueueService', `[${requestId}] Fallback: direct matching`);
        return this.directMatching(job, resumeText, resumeHash);
      }
      throw new Error('Queue unavailable and fallback disabled');
    }

    const jobData: MatchingJobData = {
      job: {
        contentHash: job.contentHash,
        title: job.title,
        company: job.company,
        description: job.description,
        location: job.location,
        isRemote: job.isRemote,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        salaryCurrency: job.salaryCurrency,
        applicationUrl: job.applicationUrl,
        postedDate: job.postedDate?.toISOString(),
        source: job.source,
        sourceId: job.sourceId,
      },
      resumeText,
      resumeHash,
      requestId,
      priority,
    };

    const queueJob = await matchingQueue.add(jobData, {
      priority,
      removeOnComplete: 100,
      removeOnFail: 50,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      timeout: MATCHING_TIMEOUT, // Bull job timeout
    });

    try {
      return await waitWithTimeout(queueJob, MATCHING_TIMEOUT);
    } catch (error) {
      // Log timeout errors with context for debugging
      if (error instanceof Error && error.message.includes('timed out')) {
        logger.error('QueueService', `[${requestId}] Matching timed out for job: "${job.title}" at ${job.company}`, error);
      }
      throw error;
    }
  }

  /**
   * Check if queue system is available
   */
  isAvailable(): boolean {
    return isRedisConnected();
  }

  /**
   * Clear the in-memory request cache
   * Useful after a scheduler run completes
   */
  clearRequestCache(): void {
    const size = requestCache.size;
    requestCache.clear();
    if (size > 0) {
      logger.debug('QueueService', `Cleared ${size} entries from request cache`);
    }
  }

  /**
   * Get request cache stats (for debugging)
   */
  getRequestCacheStats(): { size: number; ttlMs: number } {
    return { size: requestCache.size, ttlMs: REQUEST_CACHE_TTL };
  }

  /**
   * Shutdown the queue service - stops cache cleanup interval
   * Call this on graceful shutdown to prevent memory leaks
   */
  shutdown(): void {
    stopCacheCleanup();
    this.clearRequestCache();
    logger.info('QueueService', 'Shutdown complete - cleanup interval stopped');
  }

  // Fallback: direct collection using p-limit
  private async directCollection(
    params: Omit<CollectionJobData, 'requestId' | 'priority'>
  ): Promise<RawJob[]> {
    const { CollectorService } = await import('../services/collector.js');
    const collector = new CollectorService();

    return fallbackJobspyLimit(() =>
      collector.execute({
        query: params.query,
        location: params.location,
        isRemote: params.isRemote,
        jobType: params.jobType,
        limit: params.limit,
        source: params.source,
        skipCache: params.skipCache,
        datePosted: params.datePosted,
      })
    );
  }

  // Fallback: direct matching using p-limit
  private async directMatching(
    job: NormalizedJob,
    resumeText: string,
    resumeHash: string
  ): Promise<{ match: JobMatchResult; cached: boolean; jobMatchId?: string }> {
    const { MatcherAgent } = await import('../agents/matcher.js');
    const { getDb } = await import('../db/client.js');
    const matcher = new MatcherAgent();
    const db = getDb();

    return fallbackLlmLimit(async () => {
      // Check cache first
      const existingJob = await db.job.findUnique({
        where: { contentHash: job.contentHash },
        include: { matches: { where: { resumeHash }, take: 1 } },
      });

      if (existingJob?.matches?.[0]) {
        const cached = existingJob.matches[0];
        return {
          match: {
            score: cached.score,
            reasoning: cached.reasoning,
            matchedSkills: cached.matchedSkills,
            missingSkills: cached.missingSkills,
            pros: cached.pros,
            cons: cached.cons,
          },
          cached: true,
          jobMatchId: cached.id,
        };
      }

      // No cache - call LLM
      const matchResult = await matcher.execute({ job, resumeText });
      return { match: matchResult, cached: false };
    });
  }
}

// Singleton instance
export const queueService = new QueueService();

// Re-export PRIORITY for convenience
export { PRIORITY };
