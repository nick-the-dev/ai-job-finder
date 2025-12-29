import crypto from 'crypto';
import pLimit from 'p-limit';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { isRedisConnected } from './redis.js';
import { getQueues, PRIORITY, type CollectionJobData, type MatchingJobData, type Priority } from './queues.js';
import type { RawJob, NormalizedJob, JobMatchResult } from '../core/types.js';

// Fallback rate limiters (used when Redis is down)
const fallbackJobspyLimit = pLimit(2);
const fallbackLlmLimit = pLimit(5);

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
   */
  async enqueueCollection(
    params: Omit<CollectionJobData, 'requestId' | 'priority'>,
    priority: Priority = PRIORITY.API_REQUEST
  ): Promise<RawJob[]> {
    const requestId = generateRequestId();
    const { collectionQueue } = getQueues();

    if (!collectionQueue || !isRedisConnected()) {
      if (config.QUEUE_FALLBACK_ENABLED) {
        logger.debug('QueueService', `[${requestId}] Fallback: direct collection`);
        return this.directCollection(params);
      }
      throw new Error('Queue unavailable and fallback disabled');
    }

    logger.debug('QueueService', `[${requestId}] Enqueueing collection: "${params.query}"`);

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
      }
    );

    const result = await job.finished();
    return result as RawJob[];
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
    });

    return await queueJob.finished();
  }

  /**
   * Check if queue system is available
   */
  isAvailable(): boolean {
    return isRedisConnected();
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
