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
 * Adaptive batch processor configuration
 */
interface BatchProcessorConfig {
  initialBatchSize: number;
  minBatchSize: number;
  maxBatchSize: number;
  initialDelayMs: number;
  minDelayMs: number;
  maxDelayMs: number;
  rateUpThreshold: number;      // Success rate to increase speed
  rateDownThreshold: number;    // Success rate to decrease speed
  rateWindowSize: number;       // Number of batches to consider for rate calculation
}

const DEFAULT_CONFIG: BatchProcessorConfig = {
  initialBatchSize: 5,
  minBatchSize: 1,
  maxBatchSize: 10,
  initialDelayMs: 1000,
  minDelayMs: 500,
  maxDelayMs: 10000,
  rateUpThreshold: 0.95,        // Speed up if 95%+ success
  rateDownThreshold: 0.8,       // Slow down if <80% success
  rateWindowSize: 3,            // Consider last 3 batches
};

/**
 * Adaptive batch processor for LLM matching via Bull queue.
 *
 * Features:
 * - Enqueues jobs in batches to Bull queue
 * - Detects rate limits and errors
 * - Dynamically adjusts batch size and delay based on success rate
 * - Provides progress callbacks for UI updates
 */
export class AdaptiveBatchProcessor {
  private config: BatchProcessorConfig;
  private currentBatchSize: number;
  private currentDelayMs: number;
  private recentSuccessRates: number[] = [];
  private stats = {
    totalProcessed: 0,
    totalSuccess: 0,
    totalCached: 0,
    totalErrors: 0,
    rateLimitHits: 0,
    batchesProcessed: 0,
  };

  constructor(config: Partial<BatchProcessorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentBatchSize = this.config.initialBatchSize;
    this.currentDelayMs = this.config.initialDelayMs;
  }

  /**
   * Batch lookup cached matches from database.
   * Returns a Map of contentHash -> cached result for quick lookup.
   */
  private async batchCacheLookup(
    jobs: NormalizedJob[],
    resumeHash: string
  ): Promise<Map<string, { match: JobMatchResult; jobMatchId: string }>> {
    const db = getDb();
    const cacheMap = new Map<string, { match: JobMatchResult; jobMatchId: string }>();

    if (jobs.length === 0) return cacheMap;

    // Batch query: find all jobs that have matches for this resumeHash
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
   * First checks cache in batch, then only sends uncached jobs to LLM queue.
   */
  async processAll(
    jobs: NormalizedJob[],
    resumeText: string,
    resumeHash: string,
    priority: Priority = PRIORITY.SCHEDULED,
    onProgress?: BatchProgressCallback
  ): Promise<MatchingResult[]> {
    logger.info('BatchProcessor', `Starting adaptive batch processing for ${jobs.length} jobs`);

    // Step 1: Batch cache lookup - get all cached matches in one query
    logger.info('BatchProcessor', `Checking cache for ${jobs.length} jobs...`);
    const cacheStartTime = Date.now();
    const cacheMap = await this.batchCacheLookup(jobs, resumeHash);
    const cacheLookupTime = Date.now() - cacheStartTime;
    logger.info('BatchProcessor', `Cache lookup complete: ${cacheMap.size}/${jobs.length} cached (${cacheLookupTime}ms)`);

    // Step 2: Separate cached vs uncached jobs
    const cachedResults: MatchingResult[] = [];
    const uncachedJobs: NormalizedJob[] = [];

    for (const job of jobs) {
      const cached = cacheMap.get(job.contentHash);
      if (cached) {
        cachedResults.push({
          job,
          match: cached.match,
          cached: true,
          jobMatchId: cached.jobMatchId,
        });
        this.stats.totalProcessed++;
        this.stats.totalSuccess++;
        this.stats.totalCached++;
      } else {
        uncachedJobs.push(job);
      }
    }

    logger.info('BatchProcessor',
      `Cache results: ${cachedResults.length} from cache, ${uncachedJobs.length} need LLM processing`
    );

    // Step 3: Process uncached jobs through queue with adaptive batching
    const allResults: MatchingResult[] = [...cachedResults];
    let processed = cachedResults.length;

    // Call progress for cached results
    if (onProgress && cachedResults.length > 0) {
      await onProgress(processed, jobs.length, cachedResults);
    }

    // If no uncached jobs, we're done
    if (uncachedJobs.length === 0) {
      logger.info('BatchProcessor', `All ${jobs.length} jobs were cached - no LLM calls needed`);
      return allResults;
    }

    logger.info('BatchProcessor',
      `Processing ${uncachedJobs.length} uncached jobs with adaptive batching (batchSize=${this.currentBatchSize}, delay=${this.currentDelayMs}ms)`
    );

    let uncachedProcessed = 0;

    while (uncachedProcessed < uncachedJobs.length) {
      const batchStart = uncachedProcessed;
      const batchEnd = Math.min(uncachedProcessed + this.currentBatchSize, uncachedJobs.length);
      const batch = uncachedJobs.slice(batchStart, batchEnd);

      logger.info('BatchProcessor',
        `Processing batch ${this.stats.batchesProcessed + 1}: ${batch.length} jobs (${batchStart + 1}-${batchEnd} of ${uncachedJobs.length} uncached)`
      );

      const batchStartTime = Date.now();
      const batchResults = await this.processBatch(batch, resumeText, resumeHash, priority);
      const batchDuration = Date.now() - batchStartTime;

      allResults.push(...batchResults);
      uncachedProcessed = batchEnd;
      processed = cachedResults.length + uncachedProcessed;
      this.stats.batchesProcessed++;

      // Calculate success rate for this batch (only uncached, since all cached succeeded)
      const successCount = batchResults.filter(r => r.match !== null).length;
      const successRate = batch.length > 0 ? successCount / batch.length : 1;
      this.updateAdaptiveParameters(successRate, batchResults);

      // Log batch stats
      const errors = batchResults.filter(r => r.error).length;
      logger.info('BatchProcessor',
        `Batch ${this.stats.batchesProcessed} complete: ${successCount}/${batch.length} success, ${errors} errors, ${batchDuration}ms ` +
        `(total: ${processed}/${jobs.length})`
      );

      // Call progress callback
      if (onProgress) {
        await onProgress(processed, jobs.length, batchResults);
      }

      // Delay before next batch (unless this is the last batch)
      if (uncachedProcessed < uncachedJobs.length) {
        logger.debug('BatchProcessor', `Waiting ${this.currentDelayMs}ms before next batch...`);
        await this.delay(this.currentDelayMs);
      }
    }

    logger.info('BatchProcessor',
      `Batch processing complete: ${this.stats.totalProcessed} processed, ${this.stats.totalSuccess} success, ` +
      `${this.stats.totalCached} cached, ${this.stats.totalErrors} errors, ${this.stats.rateLimitHits} rate limits`
    );

    return allResults;
  }

  /**
   * Process a single batch of jobs in parallel via Bull queue
   */
  private async processBatch(
    batch: NormalizedJob[],
    resumeText: string,
    resumeHash: string,
    priority: Priority
  ): Promise<MatchingResult[]> {
    // Enqueue all jobs in batch simultaneously
    const promises = batch.map(job =>
      this.processWithErrorHandling(job, resumeText, resumeHash, priority)
    );

    // Wait for all to complete (or fail)
    const results = await Promise.allSettled(promises);

    return results.map((result, idx) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        // Handle rejected promise
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        return {
          job: batch[idx],
          match: null,
          cached: false,
          error,
        };
      }
    });
  }

  /**
   * Process a single job with error handling and rate limit detection
   */
  private async processWithErrorHandling(
    job: NormalizedJob,
    resumeText: string,
    resumeHash: string,
    priority: Priority
  ): Promise<MatchingResult> {
    this.stats.totalProcessed++;

    try {
      const result = await queueService.enqueueMatching(job, resumeText, resumeHash, priority);

      this.stats.totalSuccess++;
      if (result.cached) {
        this.stats.totalCached++;
      }

      return {
        job,
        match: result.match,
        cached: result.cached,
        jobMatchId: result.jobMatchId,
      };
    } catch (error) {
      this.stats.totalErrors++;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Detect rate limit errors
      if (this.isRateLimitError(errorMessage)) {
        this.stats.rateLimitHits++;
        logger.warn('BatchProcessor', `Rate limit detected for job "${job.title}": ${errorMessage}`);
      } else {
        logger.error('BatchProcessor', `Error processing job "${job.title}": ${errorMessage}`);
      }

      return {
        job,
        match: null,
        cached: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Detect if an error is a rate limit error
   */
  private isRateLimitError(errorMessage: string): boolean {
    const rateLimitPatterns = [
      /rate.?limit/i,
      /429/i,
      /too.?many.?requests/i,
      /quota.?exceeded/i,
      /throttl/i,
      /capacity/i,
    ];
    return rateLimitPatterns.some(pattern => pattern.test(errorMessage));
  }

  /**
   * Update batch size and delay based on recent success rates
   */
  private updateAdaptiveParameters(successRate: number, batchResults: MatchingResult[]): void {
    // Track recent success rates
    this.recentSuccessRates.push(successRate);
    if (this.recentSuccessRates.length > this.config.rateWindowSize) {
      this.recentSuccessRates.shift();
    }

    // Calculate average success rate over window
    const avgSuccessRate = this.recentSuccessRates.reduce((a, b) => a + b, 0) / this.recentSuccessRates.length;

    // Check for rate limit errors specifically
    const hasRateLimitError = batchResults.some(r => r.error && this.isRateLimitError(r.error));

    if (hasRateLimitError) {
      // Rate limit hit - significantly slow down
      this.currentBatchSize = Math.max(this.config.minBatchSize, Math.floor(this.currentBatchSize / 2));
      this.currentDelayMs = Math.min(this.config.maxDelayMs, this.currentDelayMs * 2);
      logger.warn('BatchProcessor',
        `Rate limit detected! Reducing speed: batchSize=${this.currentBatchSize}, delay=${this.currentDelayMs}ms`
      );
    } else if (avgSuccessRate >= this.config.rateUpThreshold && this.recentSuccessRates.length >= this.config.rateWindowSize) {
      // High success rate - speed up gradually
      const newBatchSize = Math.min(this.config.maxBatchSize, this.currentBatchSize + 1);
      const newDelay = Math.max(this.config.minDelayMs, Math.floor(this.currentDelayMs * 0.9));

      if (newBatchSize !== this.currentBatchSize || newDelay !== this.currentDelayMs) {
        this.currentBatchSize = newBatchSize;
        this.currentDelayMs = newDelay;
        logger.info('BatchProcessor',
          `Success rate high (${(avgSuccessRate * 100).toFixed(1)}%), speeding up: batchSize=${this.currentBatchSize}, delay=${this.currentDelayMs}ms`
        );
      }
    } else if (avgSuccessRate < this.config.rateDownThreshold) {
      // Low success rate - slow down
      this.currentBatchSize = Math.max(this.config.minBatchSize, this.currentBatchSize - 1);
      this.currentDelayMs = Math.min(this.config.maxDelayMs, Math.floor(this.currentDelayMs * 1.5));
      logger.warn('BatchProcessor',
        `Success rate low (${(avgSuccessRate * 100).toFixed(1)}%), slowing down: batchSize=${this.currentBatchSize}, delay=${this.currentDelayMs}ms`
      );
    }
  }

  /**
   * Get current stats
   */
  getStats() {
    return {
      ...this.stats,
      currentBatchSize: this.currentBatchSize,
      currentDelayMs: this.currentDelayMs,
      avgSuccessRate: this.recentSuccessRates.length > 0
        ? this.recentSuccessRates.reduce((a, b) => a + b, 0) / this.recentSuccessRates.length
        : 1,
    };
  }

  /**
   * Reset stats (for new run)
   */
  reset(): void {
    this.currentBatchSize = this.config.initialBatchSize;
    this.currentDelayMs = this.config.initialDelayMs;
    this.recentSuccessRates = [];
    this.stats = {
      totalProcessed: 0,
      totalSuccess: 0,
      totalCached: 0,
      totalErrors: 0,
      rateLimitHits: 0,
      batchesProcessed: 0,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton for shared use
export const batchProcessor = new AdaptiveBatchProcessor();
