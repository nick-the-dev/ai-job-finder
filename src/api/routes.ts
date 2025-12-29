import { Router, Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { getDb } from '../db/client.js';
import { CollectorService } from '../services/collector.js';
import { NormalizerService } from '../services/normalizer.js';
import { MatcherAgent } from '../agents/matcher.js';
import { QueryExpanderAgent } from '../agents/query-expander.js';
import type { RawJob, NormalizedJob, JobMatchResult, SearchResult } from '../core/types.js';

export const router = Router();

// Services (singleton instances)
const collector = new CollectorService();
const normalizer = new NormalizerService();
const matcher = new MatcherAgent();
const queryExpander = new QueryExpanderAgent();

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
    const { jobTitles, resumeText, limit = 1000, matchLimit, source = 'serpapi', skipCache = false, datePosted = 'month', widerSearch = false } = req.body;

    // Handle location and isRemote:
    // - location: "Remote" alone → remote jobs, no geo filter
    // - location: "USA", isRemote: true → remote jobs for USA-based candidates
    // - location: "New York" → on-site jobs in New York
    const locationIsRemote = req.body.location?.toLowerCase() === 'remote';
    const location = locationIsRemote ? undefined : req.body.location;
    const isRemote = req.body.isRemote ?? locationIsRemote;

    const effectiveMatchLimit = matchLimit ?? limit;

    logger.info('API', `=== Search: ${jobTitles.join(', ')} | ${location || 'Any location'} | ${isRemote ? 'Remote' : 'On-site'} | limit=${limit} ===`);

    if (!jobTitles || !Array.isArray(jobTitles) || jobTitles.length === 0) {
      return res.status(400).json({ error: 'jobTitles array is required' });
    }

    if (!resumeText) {
      return res.status(400).json({ error: 'resumeText is required for matching' });
    }

    // Step 0: Expand job titles if widerSearch is enabled
    let effectiveJobTitles = jobTitles;
    let expansionDetails: { original: string[]; fromExpansion: string[]; fromResume: string[]; total: number } | undefined;

    if (widerSearch) {
      logger.info('API', 'Step 0: Expanding job titles for wider search...');
      const expansion = await queryExpander.execute({ jobTitles, resumeText });

      effectiveJobTitles = expansion.allTitles;
      expansionDetails = {
        original: jobTitles,
        fromExpansion: expansion.fromExpansion,
        fromResume: expansion.fromResume,
        total: effectiveJobTitles.length,
      };
      logger.info('API', `Expanded ${jobTitles.length} titles to ${effectiveJobTitles.length} titles`);
    }

    // Step 1: Collect jobs from all titles
    logger.info('API', `[1/4] Collecting jobs from ${effectiveJobTitles.length} title(s)...`);
    const allRawJobs: RawJob[] = [];

    for (let i = 0; i < effectiveJobTitles.length; i++) {
      const title = effectiveJobTitles[i];
      // Don't add "Remote" to query - SerpAPI handles it via ltype parameter
      const shouldAddLocation = location && location.toLowerCase() !== 'remote';
      const query = shouldAddLocation ? `${title} ${location}` : title;
      const jobs = await collector.execute({
        query,
        location,
        isRemote,
        limit, // Fetch all available jobs per title, dedup handles overlaps
        source,
        skipCache,
        datePosted,
      });
      allRawJobs.push(...jobs);
      logger.info('API', `      ↳ ${i + 1}/${effectiveJobTitles.length} "${title}" → ${jobs.length} jobs (total: ${allRawJobs.length})`);
    }

    // Count by source before dedup
    const sourceCountsBefore: Record<string, number> = {};
    for (const job of allRawJobs) {
      sourceCountsBefore[job.source] = (sourceCountsBefore[job.source] || 0) + 1;
    }
    const sourcesBefore = Object.entries(sourceCountsBefore).map(([s, c]) => `${s}: ${c}`).join(', ');

    // Step 2: Normalize and deduplicate
    logger.info('API', `[2/4] Deduplicating ${allRawJobs.length} jobs (${sourcesBefore})...`);
    const normalizedJobs = await normalizer.execute(allRawJobs);

    // Count by source after dedup
    const sourceCountsAfter: Record<string, number> = {};
    for (const job of normalizedJobs) {
      sourceCountsAfter[job.source] = (sourceCountsAfter[job.source] || 0) + 1;
    }
    const sourcesAfter = Object.entries(sourceCountsAfter).map(([s, c]) => `${s}: ${c}`).join(', ');
    const duplicates = allRawJobs.length - normalizedJobs.length;
    logger.info('API', `      ↳ ${normalizedJobs.length} unique (${sourcesAfter}) | ${duplicates} duplicates removed`);

    // Step 3: Match jobs against resume (parallel batches of 20)
    const jobsToMatch = normalizedJobs.slice(0, effectiveMatchLimit);
    const BATCH_SIZE = 20;
    const totalBatches = Math.ceil(jobsToMatch.length / BATCH_SIZE);
    logger.info('API', `[3/4] Matching ${jobsToMatch.length} jobs against resume (${totalBatches} batches)...`);
    const matches: Array<{ job: NormalizedJob; match: JobMatchResult }> = [];

    for (let i = 0; i < jobsToMatch.length; i += BATCH_SIZE) {
      const batch = jobsToMatch.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const pct = Math.round((batchNum / totalBatches) * 100);

      const batchResults = await Promise.allSettled(
        batch.map(async (job) => {
          const matchResult = await matcher.execute({ job, resumeText });
          const verified = await matcher.verify(matchResult, job);
          return { job, match: matchResult, warnings: verified.warnings };
        })
      );

      let batchSuccess = 0;
      let batchWarnings = 0;
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          matches.push({ job: result.value.job, match: result.value.match });
          batchSuccess++;
          if (result.value.warnings.length > 0) batchWarnings++;
        }
      }
      logger.info('API', `      ↳ Batch ${batchNum}/${totalBatches} (${pct}%) → ${batchSuccess} matched${batchWarnings > 0 ? `, ${batchWarnings} warnings` : ''}`);
    }

    // Step 4: Sort by score descending
    matches.sort((a, b) => b.match.score - a.match.score);

    // Step 5: Save to database
    logger.info('API', `[4/4] Saving ${matches.length} matches to database...`);
    const db = getDb();
    let savedCount = 0;
    let errorCount = 0;

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
        savedCount++;
      } catch (dbError) {
        errorCount++;
      }
    }
    logger.info('API', `      ↳ Saved ${savedCount} matches${errorCount > 0 ? `, ${errorCount} errors` : ''}`);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const topScore = matches.length > 0 ? matches[0].match.score : 0;
    logger.info('API', `=== Done in ${duration}s | ${matches.length} matches | Top score: ${topScore} ===`);

    const result: SearchResult & { expansion?: typeof expansionDetails } = {
      jobsCollected: allRawJobs.length,
      jobsAfterDedup: normalizedJobs.length,
      jobsMatched: matches.length,
      matches,
      expansion: expansionDetails,
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
