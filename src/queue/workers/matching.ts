import { Job } from 'bull';
import * as Sentry from '@sentry/node';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { MatcherAgent } from '../../agents/matcher.js';
import { getDb } from '../../db/client.js';
import { getQueues, type MatchingJobData } from '../queues.js';
import type { NormalizedJob, JobMatchResult } from '../../core/types.js';
import { addQueueBreadcrumb } from '../../utils/sentry.js';
import { trackMatchCacheHit, trackMatchScore } from '../../observability/metrics.js';

const matcher = new MatcherAgent();

interface MatchingResult {
  match: JobMatchResult;
  cached: boolean;
  jobMatchId?: string;
}

/**
 * Process a matching job from the queue
 */
export async function processMatchingJob(job: Job<MatchingJobData>): Promise<MatchingResult> {
  const { job: jobData, resumeText, resumeHash, requestId } = job.data;
  const db = getDb();

  logger.debug('Worker:Matching', `[${requestId}] Processing: "${jobData.title}" @ ${jobData.company}`);

  addQueueBreadcrumb('matching', 'process', { jobTitle: jobData.title, company: jobData.company, jobId: String(job.id) });

  // Wrap entire matching job in a Sentry span for performance monitoring
  return Sentry.startSpan(
    {
      op: 'queue.process',
      name: 'matching.llm',
      attributes: {
        'queue.name': 'matching',
        'job.id': String(job.id),
        'job.title': jobData.title,
        'job.company': jobData.company,
      },
    },
    async () => {
      // Check for cached match first
      const existingJob = await db.job.findUnique({
        where: { contentHash: jobData.contentHash },
        include: {
          matches: {
            where: { resumeHash },
            take: 1,
          },
        },
      });

      if (existingJob?.matches?.[0]) {
        const cached = existingJob.matches[0];
        logger.debug('Worker:Matching', `[${requestId}] Cache hit for "${jobData.title}"`);
        addQueueBreadcrumb('matching', 'complete', { cached: true, score: cached.score });
        trackMatchCacheHit(true);
        trackMatchScore(cached.score);
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

      // Reconstruct NormalizedJob for matcher
      const normalizedJob: NormalizedJob = {
        contentHash: jobData.contentHash,
        title: jobData.title,
        company: jobData.company,
        description: jobData.description,
        location: jobData.location,
        isRemote: jobData.isRemote,
        salaryMin: jobData.salaryMin,
        salaryMax: jobData.salaryMax,
        salaryCurrency: jobData.salaryCurrency,
        applicationUrl: jobData.applicationUrl,
        postedDate: jobData.postedDate ? new Date(jobData.postedDate) : undefined,
        source: jobData.source as 'serpapi' | 'jobspy',
        sourceId: jobData.sourceId,
      };

      // Call LLM for matching with trace context for observability
      const { traceContext } = job.data;
      const matchResult = await matcher.execute({
        job: normalizedJob,
        resumeText,
        traceContext: traceContext ? {
          subscriptionId: traceContext.subscriptionId,
          runId: traceContext.runId,
          userId: traceContext.userId,
          username: traceContext.username,
          jobTitle: jobData.title,
          company: jobData.company,
        } : undefined,
      });

      logger.debug('Worker:Matching', `[${requestId}] Score: ${matchResult.score} for "${jobData.title}"`);
      addQueueBreadcrumb('matching', 'complete', { cached: false, score: matchResult.score });
      trackMatchCacheHit(false);
      trackMatchScore(matchResult.score);

      return {
        match: matchResult,
        cached: false,
      };
    }
  );
}

/**
 * Start the matching worker
 */
export function startMatchingWorker(): boolean {
  const { matchingQueue } = getQueues();

  if (!matchingQueue) {
    logger.warn('Worker:Matching', 'Queue not available - worker disabled');
    return false;
  }

  matchingQueue.process(config.QUEUE_LLM_CONCURRENCY, processMatchingJob);
  logger.info('Worker:Matching', `Started with concurrency: ${config.QUEUE_LLM_CONCURRENCY}`);
  return true;
}
