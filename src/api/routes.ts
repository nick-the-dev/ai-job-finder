import { Router, Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { getDb } from '../db/client.js';
import { CollectorService } from '../services/collector.js';
import { NormalizerService } from '../services/normalizer.js';
import { MatcherAgent } from '../agents/matcher.js';
import type { NormalizedJob, JobMatchResult, SearchResult } from '../core/types.js';

export const router = Router();

// Services (singleton instances)
const collector = new CollectorService();
const normalizer = new NormalizerService();
const matcher = new MatcherAgent();

/**
 * Health check
 */
router.get('/health', (req: Request, res: Response) => {
  logger.info('API', 'Health check');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * POST /search - Trigger job search and matching
 */
router.post('/search', async (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();

  try {
    const { jobTitles, resumeText, limit = 5, matchLimit, source = 'serpapi', skipCache = false } = req.body;

    // Handle location and isRemote:
    // - location: "Remote" alone → remote jobs, no geo filter
    // - location: "USA", isRemote: true → remote jobs for USA-based candidates
    // - location: "New York" → on-site jobs in New York
    const locationIsRemote = req.body.location?.toLowerCase() === 'remote';
    const location = locationIsRemote ? undefined : req.body.location;
    const isRemote = req.body.isRemote ?? locationIsRemote;

    const effectiveMatchLimit = matchLimit ?? limit;

    logger.info('API', '=== Starting job search ===');
    logger.info('API', 'Request', { jobTitles, location, isRemote, limit });

    if (!jobTitles || !Array.isArray(jobTitles) || jobTitles.length === 0) {
      return res.status(400).json({ error: 'jobTitles array is required' });
    }

    if (!resumeText) {
      return res.status(400).json({ error: 'resumeText is required for matching' });
    }

    // Step 1: Collect jobs from all titles
    logger.info('API', 'Step 1: Collecting jobs...');
    const allRawJobs = [];

    for (const title of jobTitles) {
      // Don't add "Remote" to query - SerpAPI handles it via ltype parameter
      const shouldAddLocation = location && location.toLowerCase() !== 'remote';
      const query = shouldAddLocation ? `${title} ${location}` : title;
      const jobs = await collector.execute({
        query,
        location,
        isRemote,
        limit: Math.ceil(limit / jobTitles.length) + 2, // Get a few extra per title
        source,
        skipCache,
      });
      allRawJobs.push(...jobs);
    }

    logger.info('API', `Collected ${allRawJobs.length} total jobs`);

    // Step 2: Normalize and deduplicate
    logger.info('API', 'Step 2: Normalizing and deduping...');
    const normalizedJobs = await normalizer.execute(allRawJobs);
    logger.info('API', `After dedup: ${normalizedJobs.length} unique jobs`);

    // Step 3: Match jobs against resume
    logger.info('API', 'Step 3: Matching jobs against resume...');
    const matches: Array<{ job: NormalizedJob; match: JobMatchResult }> = [];

    for (const job of normalizedJobs.slice(0, effectiveMatchLimit)) {
      try {
        const matchResult = await matcher.execute({ job, resumeText });

        // Verify the result
        const verified = await matcher.verify(matchResult, job);
        if (verified.warnings.length > 0) {
          logger.warn('API', `Match warnings for ${job.title}`, verified.warnings);
        }

        matches.push({ job, match: matchResult });
      } catch (error) {
        logger.error('API', `Failed to match: ${job.title}`, error);
        // Continue with other jobs
      }
    }

    // Step 4: Sort by score descending
    matches.sort((a, b) => b.match.score - a.match.score);

    // Step 5: Save to database
    logger.info('API', 'Step 4: Saving to database...');
    const db = getDb();

    for (const { job, match } of matches) {
      try {
        // Upsert job
        const savedJob = await db.job.upsert({
          where: { contentHash: job.contentHash },
          create: {
            contentHash: job.contentHash,
            title: job.title,
            company: job.company,
            description: job.description,
            location: job.location,
            isRemote: job.isRemote || false,
            salaryMin: job.salaryMin,
            salaryMax: job.salaryMax,
            salaryCurrency: job.salaryCurrency,
            source: job.source,
            sourceId: job.sourceId,
            applicationUrl: job.applicationUrl,
            postedDate: job.postedDate,
          },
          update: {
            lastSeenAt: new Date(),
          },
        });

        // Create match record
        await db.jobMatch.create({
          data: {
            jobId: savedJob.id,
            score: match.score,
            reasoning: match.reasoning,
            matchedSkills: match.matchedSkills,
            missingSkills: match.missingSkills,
            pros: match.pros,
            cons: match.cons,
          },
        });
      } catch (dbError) {
        logger.error('API', `DB error for ${job.title}`, dbError);
      }
    }

    const duration = Date.now() - startTime;
    logger.info('API', `=== Search complete in ${duration}ms ===`);

    const result: SearchResult = {
      jobsCollected: allRawJobs.length,
      jobsAfterDedup: normalizedJobs.length,
      jobsMatched: matches.length,
      matches,
    };

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /jobs - List all collected jobs
 */
router.get('/jobs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info('API', 'Fetching all jobs...');
    const db = getDb();

    const jobs = await db.job.findMany({
      orderBy: { lastSeenAt: 'desc' },
      take: 1000,
    });

    logger.info('API', `Returning ${jobs.length} jobs`);
    res.json({ count: jobs.length, jobs });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /matches - List all job matches with scores
 */
router.get('/matches', async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info('API', 'Fetching all matches...');
    const db = getDb();

    const matches = await db.jobMatch.findMany({
      include: { job: true },
      orderBy: { score: 'desc' },
      take: 1000,
    });

    logger.info('API', `Returning ${matches.length} matches`);
    res.json({ count: matches.length, matches });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /matches/:id - Get specific match details
 */
router.get('/matches/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    logger.info('API', `Fetching match: ${id}`);

    const db = getDb();
    const match = await db.jobMatch.findUnique({
      where: { id },
      include: { job: true },
    });

    if (!match) {
      return res.status(404).json({ error: 'Match not found' });
    }

    res.json(match);
  } catch (error) {
    next(error);
  }
});

/**
 * Error handling middleware
 */
export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  logger.error('API', 'Unhandled error', { message: err.message, stack: err.stack });
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
}
