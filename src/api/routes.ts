import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { getDb } from '../db/client.js';
import { NormalizerService } from '../services/normalizer.js';
import { MatcherAgent } from '../agents/matcher.js';
import { QueryExpanderAgent } from '../agents/query-expander.js';
import { saveMatchesToCSV, generateDownloadToken, validateDownloadToken, getExportFile } from '../utils/csv.js';
import { queueService, PRIORITY, getQueueStatus, isRedisConnected } from '../queue/index.js';
import type { RawJob, NormalizedJob, JobMatchResult, SearchResult } from '../core/types.js';

/**
 * Generate a hash of resume text for caching matches
 */
function getResumeHash(resumeText: string): string {
  return crypto.createHash('sha256').update(resumeText).digest('hex').substring(0, 16);
}

export const router = Router();

// Services (singleton instances)
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
 * GET /queue/status - Queue monitoring endpoint
 */
router.get('/queue/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const redisConnected = isRedisConnected();

    if (!redisConnected) {
      return res.json({
        status: 'fallback',
        message: 'Redis unavailable, using in-process rate limiting',
        queues: null,
      });
    }

    const queueStatus = await getQueueStatus();
    res.json({
      status: 'active',
      queues: queueStatus,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /search - Trigger job search and matching
 */
router.post('/search', async (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();

  try {
    const { jobTitles, resumeText, limit = 1000, matchLimit, source = 'serpapi', skipCache = false, datePosted = 'month', widerSearch = false, minScore = 40 } = req.body;

    // Handle location and isRemote:
    // - location: "Remote" alone → remote jobs only, no geo filter
    // - location: "USA", isRemote: true → remote jobs for USA-based candidates
    // - location: "USA", isRemote: false → on-site jobs only in USA
    // - location: "New York" (no isRemote) → all jobs in New York (remote + on-site)
    const locationIsRemote = req.body.location?.toLowerCase() === 'remote';
    const location = locationIsRemote ? undefined : req.body.location;
    // Only filter by remote if explicitly requested or location is "Remote"
    const isRemote: boolean | undefined = req.body.isRemote !== undefined
      ? req.body.isRemote
      : (locationIsRemote ? true : undefined);

    const effectiveMatchLimit = matchLimit ?? limit;

    const remoteLabel = isRemote === true ? 'Remote only' : isRemote === false ? 'On-site only' : 'All (remote + on-site)';
    logger.info('API', `=== Search: ${jobTitles.join(', ')} | ${location || 'Any location'} | ${remoteLabel} | limit=${limit} ===`);

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

      // JobSpy scrapes directly and gets rate-limited quickly
      // Limit to original titles only to avoid 429 errors and redundant results
      if (source === 'jobspy' && effectiveJobTitles.length > jobTitles.length) {
        logger.warn('API', `JobSpy: limiting from ${effectiveJobTitles.length} to ${jobTitles.length} titles (scraper rate limits)`);
        effectiveJobTitles = jobTitles;
        expansionDetails.total = jobTitles.length;
      }

      logger.info('API', `Expanded ${jobTitles.length} titles to ${effectiveJobTitles.length} titles`);
    }

    // Step 1: Collect jobs from all titles via queue (rate limited)
    logger.info('API', `[1/4] Collecting jobs from ${effectiveJobTitles.length} title(s)...`);

    const shouldAddLocation = location && location.toLowerCase() !== 'remote';
    const collectPromises = effectiveJobTitles.map(async (title, i) => {
      const query = shouldAddLocation ? `${title} ${location}` : title;
      const jobs = await queueService.enqueueCollection({
        query,
        location,
        isRemote,
        limit,
        source,
        skipCache,
        datePosted,
      }, PRIORITY.API_REQUEST);
      logger.info('API', `      ↳ ${i + 1}/${effectiveJobTitles.length} "${title}" → ${jobs.length} jobs`);
      return jobs;
    });

    const results = await Promise.all(collectPromises);
    const allRawJobs: RawJob[] = results.flat();
    logger.info('API', `      ✓ Collected ${allRawJobs.length} total jobs`);

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

    // Step 3: Match jobs against resume (with caching to skip re-analysis)
    const jobsToMatch = normalizedJobs.slice(0, effectiveMatchLimit);
    const BATCH_SIZE = 20;
    const totalBatches = Math.ceil(jobsToMatch.length / BATCH_SIZE);
    const resumeHash = getResumeHash(resumeText);
    const db = getDb();

    logger.info('API', `[3/4] Matching ${jobsToMatch.length} jobs against resume (${totalBatches} batches, resumeHash: ${resumeHash})...`);
    const matches: Array<{ job: NormalizedJob; match: JobMatchResult; cached: boolean }> = [];

    let totalCached = 0;
    let totalFresh = 0;

    for (let i = 0; i < jobsToMatch.length; i += BATCH_SIZE) {
      const batch = jobsToMatch.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const pct = Math.round((batchNum / totalBatches) * 100);

      const batchResults = await Promise.allSettled(
        batch.map(async (job) => {
          // Check for cached match first
          const existingJob = await db.job.findUnique({
            where: { contentHash: job.contentHash },
            include: {
              matches: {
                where: { resumeHash },
                take: 1,
              },
            },
          });

          if (existingJob?.matches?.[0]) {
            // Use cached match - no LLM call needed!
            const cached = existingJob.matches[0];
            return {
              job,
              match: {
                score: cached.score,
                reasoning: cached.reasoning,
                matchedSkills: cached.matchedSkills,
                missingSkills: cached.missingSkills,
                pros: cached.pros,
                cons: cached.cons,
              } as JobMatchResult,
              cached: true,
              warnings: [],
            };
          }

          // No cache - call LLM
          const matchResult = await matcher.execute({ job, resumeText });
          const verified = await matcher.verify(matchResult, job);
          return { job, match: matchResult, cached: false, warnings: verified.warnings };
        })
      );

      let batchSuccess = 0;
      let batchCached = 0;
      let batchWarnings = 0;
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          matches.push({ job: result.value.job, match: result.value.match, cached: result.value.cached });
          batchSuccess++;
          if (result.value.cached) {
            batchCached++;
            totalCached++;
          } else {
            totalFresh++;
          }
          if (result.value.warnings.length > 0) batchWarnings++;
        }
      }
      const cacheInfo = batchCached > 0 ? ` (${batchCached} cached)` : '';
      logger.info('API', `      ↳ Batch ${batchNum}/${totalBatches} (${pct}%) → ${batchSuccess} matched${cacheInfo}${batchWarnings > 0 ? `, ${batchWarnings} warnings` : ''}`);
    }

    if (totalCached > 0) {
      logger.info('API', `      ✓ Cache hit: ${totalCached} jobs skipped LLM | ${totalFresh} fresh analyses`);
    }

    // Step 4: Sort by score descending and filter by minScore
    matches.sort((a, b) => b.match.score - a.match.score);
    const filteredMatches = matches.filter(m => m.match.score >= minScore);
    const filteredOut = matches.length - filteredMatches.length;
    if (filteredOut > 0) {
      logger.info('API', `      ✓ Filtered out ${filteredOut} matches with score < ${minScore}`);
    }

    // Step 5: Save fresh matches to database (cached ones are already saved)
    const freshMatches = filteredMatches.filter(m => !m.cached);
    logger.info('API', `[4/4] Saving ${freshMatches.length} new matches to database (${totalCached} already cached)...`);
    let savedCount = 0;
    let errorCount = 0;

    for (const { job, match } of freshMatches) {
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

        // Find or create match record
        const existingMatch = await db.jobMatch.findFirst({
          where: { jobId: savedJob.id, resumeHash },
        });

        if (existingMatch) {
          await db.jobMatch.update({
            where: { id: existingMatch.id },
            data: {
              score: Math.round(match.score),
              reasoning: match.reasoning,
              matchedSkills: match.matchedSkills ?? [],
              missingSkills: match.missingSkills ?? [],
              pros: match.pros ?? [],
              cons: match.cons ?? [],
            },
          });
        } else {
          await db.jobMatch.create({
            data: {
              jobId: savedJob.id,
              resumeHash,
              score: Math.round(match.score),
              reasoning: match.reasoning,
              matchedSkills: match.matchedSkills ?? [],
              missingSkills: match.missingSkills ?? [],
              pros: match.pros ?? [],
              cons: match.cons ?? [],
            },
          });
        }
        savedCount++;
      } catch (dbError) {
        errorCount++;
      }
    }
    logger.info('API', `      ↳ Saved ${savedCount} matches${errorCount > 0 ? `, ${errorCount} errors` : ''}`);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const topScore = filteredMatches.length > 0 ? filteredMatches[0].match.score : 0;
    logger.info('API', `=== Done in ${duration}s | ${filteredMatches.length} matches (minScore: ${minScore}) | Top score: ${topScore} ===`);

    // Save filtered results to CSV (strip cached field for CSV export)
    const matchesForCSV = filteredMatches.map(({ job, match }) => ({ job, match }));
    const csvFilename = await saveMatchesToCSV(matchesForCSV);
    const csvAbsolutePath = join(process.cwd(), 'exports', csvFilename);
    logger.info('API', `CSV saved: ${csvAbsolutePath}`);

    // Generate secure download token (24h expiry)
    const downloadToken = generateDownloadToken(csvFilename);
    const protocol = req.protocol;
    const host = req.get('host');
    const downloadUrl = `${protocol}://${host}/download/${downloadToken}`;

    res.json({
      jobsCollected: allRawJobs.length,
      jobsAfterDedup: normalizedJobs.length,
      jobsMatched: filteredMatches.length,
      jobsFiltered: filteredOut,
      minScore,
      matchesCached: totalCached,
      matchesFresh: totalFresh,
      topScore,
      duration: `${duration}s`,
      downloadUrl,
      expansion: expansionDetails,
    });
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
 * GET /download/:token - Secure file download with token authentication
 */
router.get('/download/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params;

    // Validate token and get filename
    const filename = validateDownloadToken(token);
    if (!filename) {
      logger.warn('API', `Invalid or expired download token: ${token.substring(0, 8)}...`);
      return res.status(404).json({ error: 'Invalid or expired download link' });
    }

    // Get file content
    const content = await getExportFile(filename);
    if (!content) {
      logger.error('API', `File not found for valid token: ${filename}`);
      return res.status(404).json({ error: 'File not found' });
    }

    logger.info('API', `Serving download: ${filename}`);

    // Set headers for file download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', content.length);
    res.send(content);
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
  // Handle JSON parsing errors (malformed request body)
  if (err instanceof SyntaxError && 'body' in err) {
    logger.warn('API', 'Invalid JSON in request body', { message: err.message });
    res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid JSON in request body',
    });
    return;
  }

  logger.error('API', 'Unhandled error', { message: err.message, stack: err.stack });
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
}
