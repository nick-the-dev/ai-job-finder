import { logger } from '../utils/logger.js';
import { queueService, PRIORITY } from './service.js';
import type { Priority } from './queues.js';
import { getDb } from '../db/client.js';
import type { NormalizedJob, JobMatchResult } from '../core/types.js';

/**
 * Result from a single matching operation
 */
export interface MatchingResult {
  job: NormalizedJob;
  match: JobMatchResult | null;
  cached: boolean;
  jobMatchId?: string;
  error?: string;
}

/**
 * Progress callback for batch processing
 */
export type BatchProgressCallback = (
  processed: number,
  total: number,
  batchResults: MatchingResult[]
) => Promise<void>;

/**
 * Trace context for LLM observability (Langfuse)
 */
export interface BatchTraceContext {
  subscriptionId?: string;
  runId?: string;
  userId?: string;
  username?: string; // Telegram username for human-readable tracking
}

/**
 * Simple adaptive batch processor for LLM matching.
 *
 * Adjusts batch size and delay based purely on API response:
 * - Success: speed up (larger batches, shorter delays)
 * - Rate limit: slow down significantly
 * - Provider error (502/503): slow down moderately
 * - Multiple consecutive errors: enter cooldown
 */
export class AdaptiveBatchProcessor {
  // Start aggressive - API will tell us if it's too much
  private batchSize = 10;
  private delayMs = 0;

  // Track consecutive success/error for adaptive behavior
  private consecutiveSuccesses = 0;
  private consecutiveErrors = 0;

  private stats = {
    totalProcessed: 0,
    totalSuccess: 0,
    totalCached: 0,
    totalErrors: 0,
    rateLimitHits: 0,
    providerErrors: 0,
    batchesProcessed: 0,
  };

  /**
   * Batch lookup cached matches from database.
   */
  private async batchCacheLookup(
    jobs: NormalizedJob[],
    resumeHash: string
  ): Promise<Map<string, { match: JobMatchResult; jobMatchId: string }>> {
    const db = getDb();
    const cacheMap = new Map<string, { match: JobMatchResult; jobMatchId: string }>();

    if (jobs.length === 0) return cacheMap;

    const contentHashes = jobs.map(j => j.contentHash);

    const cachedJobs = await db.job.findMany({
      where: {
        contentHash: { in: contentHashes },
        matches: {
          some: { resumeHash },
        },
      },
      include: {
        matches: {
          where: { resumeHash },
          take: 1,
        },
      },
    });

    for (const cachedJob of cachedJobs) {
      const match = cachedJob.matches[0];
      if (match) {
        cacheMap.set(cachedJob.contentHash, {
          match: {
            score: match.score,
            reasoning: match.reasoning,
            matchedSkills: match.matchedSkills,
            missingSkills: match.missingSkills,
            pros: match.pros,
            cons: match.cons,
          },
          jobMatchId: match.id,
        });
      }
    }

    return cacheMap;
  }

  /**
   * Process all jobs with adaptive batching.
   */
  async processAll(
    jobs: NormalizedJob[],
    resumeText: string,
    resumeHash: string,
    priority: Priority = PRIORITY.SCHEDULED,
    onProgress?: BatchProgressCallback,
    traceContext?: BatchTraceContext
  ): Promise<MatchingResult[]> {
    logger.info('BatchProcessor', `Starting batch processing for ${jobs.length} jobs`);

    // Batch cache lookup
    const cacheStartTime = Date.now();
    const cacheMap = await this.batchCacheLookup(jobs, resumeHash);
    logger.info('BatchProcessor', `Cache: ${cacheMap.size}/${jobs.length} cached (${Date.now() - cacheStartTime}ms)`);

    // Separate cached vs uncached
    const cachedResults: MatchingResult[] = [];
    const uncachedJobs: NormalizedJob[] = [];

    for (const job of jobs) {
      const cached = cacheMap.get(job.contentHash);
      if (cached) {
        cachedResults.push({ job, match: cached.match, cached: true, jobMatchId: cached.jobMatchId });
        this.stats.totalProcessed++;
        this.stats.totalSuccess++;
        this.stats.totalCached++;
      } else {
        uncachedJobs.push(job);
      }
    }

    const allResults: MatchingResult[] = [...cachedResults];
    let processed = cachedResults.length;

    if (onProgress && cachedResults.length > 0) {
      await onProgress(processed, jobs.length, cachedResults);
    }

    if (uncachedJobs.length === 0) {
      logger.info('BatchProcessor', `All ${jobs.length} jobs cached - no LLM calls needed`);
      return allResults;
    }

    logger.info('BatchProcessor', `Processing ${uncachedJobs.length} uncached jobs (starting: batch=${this.batchSize}, delay=${this.delayMs}ms)`);

    let uncachedProcessed = 0;

    while (uncachedProcessed < uncachedJobs.length) {
      const batch = uncachedJobs.slice(uncachedProcessed, uncachedProcessed + this.batchSize);

      logger.info('BatchProcessor', `Batch ${this.stats.batchesProcessed + 1}: ${batch.length} jobs (batch=${this.batchSize}, delay=${this.delayMs}ms)`);

      const batchStartTime = Date.now();
      const batchResults = await this.processBatch(batch, resumeText, resumeHash, priority, traceContext);
      const batchDuration = Date.now() - batchStartTime;

      allResults.push(...batchResults);
      uncachedProcessed += batch.length;
      processed = cachedResults.length + uncachedProcessed;
      this.stats.batchesProcessed++;

      // Adapt based on results
      this.adaptFromResults(batchResults);

      const errors = batchResults.filter(r => r.error).length;
      logger.info('BatchProcessor', `Batch done: ${batch.length - errors}/${batch.length} success, ${batchDuration}ms (total: ${processed}/${jobs.length})`);

      if (onProgress) {
        await onProgress(processed, jobs.length, batchResults);
      }

      // Delay before next batch
      if (uncachedProcessed < uncachedJobs.length && this.delayMs > 0) {
        await this.delay(this.delayMs);
      }
    }

    logger.info('BatchProcessor', `Complete: ${this.stats.totalSuccess} success, ${this.stats.totalErrors} errors, ${this.stats.rateLimitHits} rate limits`);
    return allResults;
  }

  /**
   * Process a single batch of jobs in parallel
   */
  private async processBatch(
    batch: NormalizedJob[],
    resumeText: string,
    resumeHash: string,
    priority: Priority,
    traceContext?: BatchTraceContext
  ): Promise<MatchingResult[]> {
    const promises = batch.map(job =>
      this.processWithErrorHandling(job, resumeText, resumeHash, priority, traceContext)
    );

    const results = await Promise.allSettled(promises);

    return results.map((result, idx) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        return { job: batch[idx], match: null, cached: false, error };
      }
    });
  }

  /**
   * Process a single job with error handling
   */
  private async processWithErrorHandling(
    job: NormalizedJob,
    resumeText: string,
    resumeHash: string,
    priority: Priority,
    traceContext?: BatchTraceContext
  ): Promise<MatchingResult> {
    this.stats.totalProcessed++;

    try {
      const result = await queueService.enqueueMatching(job, resumeText, resumeHash, priority, traceContext);
      this.stats.totalSuccess++;
      if (result.cached) this.stats.totalCached++;
      return { job, match: result.match, cached: result.cached, jobMatchId: result.jobMatchId };
    } catch (error) {
      this.stats.totalErrors++;
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (this.isRateLimitError(errorMessage)) {
        this.stats.rateLimitHits++;
        logger.warn('BatchProcessor', `Rate limit: ${job.title}`);
      } else if (this.isProviderError(errorMessage)) {
        this.stats.providerErrors++;
        logger.warn('BatchProcessor', `Provider error: ${job.title}`);
      } else {
        logger.error('BatchProcessor', `Error: ${job.title}: ${errorMessage}`);
      }

      return { job, match: null, cached: false, error: errorMessage };
    }
  }

  /**
   * Adapt batch size and delay based on batch results
   */
  private adaptFromResults(batchResults: MatchingResult[]): void {
    const hasRateLimit = batchResults.some(r => r.error && this.isRateLimitError(r.error));
    const hasProviderError = batchResults.some(r => r.error && this.isProviderError(r.error));
    const hasAnyError = batchResults.some(r => r.error);
    const allSuccess = !hasAnyError;

    if (hasRateLimit) {
      // Rate limit - back off hard
      this.batchSize = Math.max(1, Math.floor(this.batchSize / 2));
      this.delayMs = Math.max(this.delayMs, 1000) * 2;
      this.consecutiveSuccesses = 0;
      this.consecutiveErrors++;
      logger.warn('BatchProcessor', `Rate limit! Slowing: batch=${this.batchSize}, delay=${this.delayMs}ms`);
    } else if (hasProviderError) {
      // Provider error (502/503) - moderate slowdown
      this.batchSize = Math.max(1, Math.floor(this.batchSize * 0.7));
      this.delayMs = Math.max(this.delayMs, 500) * 1.5;
      this.consecutiveSuccesses = 0;
      this.consecutiveErrors++;
      logger.warn('BatchProcessor', `Provider error! Slowing: batch=${this.batchSize}, delay=${this.delayMs}ms`);
    } else if (this.consecutiveErrors >= 3) {
      // Cooldown mode after multiple errors
      this.batchSize = Math.max(1, Math.floor(this.batchSize / 2));
      this.delayMs = 5000;
      logger.warn('BatchProcessor', `Cooldown mode: batch=${this.batchSize}, delay=${this.delayMs}ms`);
    } else if (allSuccess) {
      // All success - speed up
      this.consecutiveSuccesses++;
      this.consecutiveErrors = 0;

      // Only speed up after 2+ consecutive successes (stability check)
      if (this.consecutiveSuccesses >= 2) {
        const newBatchSize = Math.floor(this.batchSize * 1.5);
        const newDelay = Math.max(0, Math.floor(this.delayMs * 0.5));

        if (newBatchSize !== this.batchSize || newDelay !== this.delayMs) {
          this.batchSize = newBatchSize;
          this.delayMs = newDelay;
          logger.info('BatchProcessor', `Speeding up: batch=${this.batchSize}, delay=${this.delayMs}ms`);
        }
      }
    } else {
      // Some errors but not rate limit/provider - mild slowdown
      this.batchSize = Math.max(1, Math.floor(this.batchSize * 0.9));
      this.consecutiveSuccesses = 0;
    }
  }

  private isRateLimitError(msg: string): boolean {
    return /rate.?limit|429|too.?many.?requests|quota.?exceeded|throttl|capacity/i.test(msg);
  }

  private isProviderError(msg: string): boolean {
    return /502|503|504|bad.?gateway|service.?unavailable|gateway.?timeout|timed?.?out/i.test(msg);
  }

  getStats() {
    return {
      ...this.stats,
      currentBatchSize: this.batchSize,
      currentDelayMs: this.delayMs,
    };
  }

  reset(): void {
    this.batchSize = 10;
    this.delayMs = 0;
    this.consecutiveSuccesses = 0;
    this.consecutiveErrors = 0;
    this.stats = {
      totalProcessed: 0,
      totalSuccess: 0,
      totalCached: 0,
      totalErrors: 0,
      rateLimitHits: 0,
      providerErrors: 0,
      batchesProcessed: 0,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const batchProcessor = new AdaptiveBatchProcessor();
