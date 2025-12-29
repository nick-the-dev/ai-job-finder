import { Job } from 'bull';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { MatcherAgent } from '../../agents/matcher.js';
import { getDb } from '../../db/client.js';
import { getQueues, type MatchingJobData } from '../queues.js';
import type { NormalizedJob, JobMatchResult } from '../../core/types.js';

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

  // Call LLM for matching
  const matchResult = await matcher.execute({ job: normalizedJob, resumeText });

  logger.debug('Worker:Matching', `[${requestId}] Score: ${matchResult.score} for "${jobData.title}"`);

  return {
    match: matchResult,
    cached: false,
  };
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
