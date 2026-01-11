/**
 * Parallel JobSpy Collector
 *
 * Distributes job scraping queries across multiple proxies for high-throughput collection.
 * Uses Promise.allSettled() for fault tolerance and implements smart retry logic.
 */

import axios from 'axios';
import * as Sentry from '@sentry/node';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import type { RawJob } from '../core/types.js';

interface ParallelCollectorInput {
  query: string;
  location?: string;
  isRemote?: boolean;
  jobType?: 'fulltime' | 'parttime' | 'internship' | 'contract';
  limit?: number;
  datePosted?: 'today' | '3days' | 'week' | 'month';
  country?: string;
}

interface WorkerResult {
  jobs: RawJob[];
  proxyIndex: number;
  success: boolean;
  error?: string;
}

interface ProxyMetrics {
  totalRequests: number;
  successCount: number;
  failureCount: number;
  lastSuccess?: number;
  lastFailure?: number;
}

export class ParallelCollector {
  private readonly jobspyUrl: string;
  private readonly concurrencyLimit: number;
  private readonly proxyMetrics: Map<number, ProxyMetrics> = new Map();

  constructor() {
    this.jobspyUrl = process.env.JOBSPY_URL || 'http://localhost:8000';
    this.concurrencyLimit = config.JOBSPY_PARALLEL_WORKERS;

    logger.info('ParallelCollector', `Initialized with concurrency limit: ${this.concurrencyLimit}`);
  }

  /**
   * Collect jobs using parallel workers across multiple proxies
   *
   * NOTE: For a single query, we only use 1 worker (but still use proxy rotation).
   * Running the same query 50 times just produces 50x duplicates!
   * Parallelism is only useful when collectMultiple() is called with different queries.
   */
  async collect(input: ParallelCollectorInput): Promise<RawJob[]> {
    const { query, location, isRemote, jobType, limit = 100, datePosted = 'month', country } = input;

    // For a SINGLE query, only use 1 worker - running same query multiple times = duplicates
    const actualWorkers = 1;

    logger.info('ParallelCollector', `Starting collection: "${query}" @ ${location || 'global'} (1 worker, proxy rotation enabled)`);

    return Sentry.startSpan(
      {
        op: 'jobspy.parallel',
        name: 'parallel-collector.collect',
        attributes: {
          'job.query': query,
          'job.location': location || 'global',
          'parallel.workers': actualWorkers,
        },
      },
      async (span) => {
        // Single worker fetches all jobs (proxy pool still rotates on each request)
        const staggeredWorkers: Promise<WorkerResult>[] = [];
        staggeredWorkers.push(
          this.fetchWithProxy(
            {
              query,
              location,
              isRemote,
              jobType,
              limit,
              datePosted,
              country,
            },
            0
          )
        );

        logger.info('ParallelCollector', `Worker started (proxy rotation active)`);

        // Execute all workers in parallel with fault tolerance
        const results = await Promise.allSettled(staggeredWorkers);

        // Process results
        const successfulResults: WorkerResult[] = [];
        const failedResults: { proxyIndex: number; error: string }[] = [];

        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            successfulResults.push(result.value);
            if (result.value.success) {
              this.recordSuccess(index);
            } else {
              this.recordFailure(index);
              failedResults.push({ proxyIndex: index, error: result.value.error || 'Unknown error' });
            }
          } else {
            this.recordFailure(index);
            failedResults.push({ proxyIndex: index, error: result.reason?.message || 'Worker crashed' });
          }
        });

        // Log metrics
        const successCount = successfulResults.filter(r => r.success).length;
        const failureCount = this.concurrencyLimit - successCount;
        logger.info('ParallelCollector', `Workers completed: ${successCount} success, ${failureCount} failed`);

        if (failedResults.length > 0) {
          logger.warn('ParallelCollector', `Failed workers:`, failedResults);
        }

        // Aggregate and deduplicate results
        const allJobs = successfulResults
          .filter(r => r.success)
          .flatMap(r => r.jobs);

        const deduplicatedJobs = this.deduplicateJobs(allJobs);
        const finalJobs = deduplicatedJobs.slice(0, limit);

        span.setAttribute('jobs.collected', allJobs.length);
        span.setAttribute('jobs.deduplicated', deduplicatedJobs.length);
        span.setAttribute('jobs.returned', finalJobs.length);
        span.setAttribute('workers.success', successCount);
        span.setAttribute('workers.failed', failureCount);

        logger.info('ParallelCollector', `Collected ${allJobs.length} jobs, deduplicated to ${deduplicatedJobs.length}, returning ${finalJobs.length}`);

        // Retry failed workers if needed and we didn't get enough jobs
        if (finalJobs.length < limit && failedResults.length > 0) {
          logger.info('ParallelCollector', `Retrying ${failedResults.length} failed workers to reach target limit`);
          const retryJobs = await this.retryFailedWorkers(input, failedResults);
          const combinedJobs = this.deduplicateJobs([...finalJobs, ...retryJobs]);
          return combinedJobs.slice(0, limit);
        }

        return finalJobs;
      }
    );
  }

  /**
   * Fetch jobs with a specific proxy index
   */
  private async fetchWithProxy(
    input: ParallelCollectorInput,
    proxyIndex: number
  ): Promise<WorkerResult> {
    const { query, location, isRemote, jobType, limit, datePosted, country } = input;

    try {
      logger.debug('ParallelCollector', `Worker ${proxyIndex}: Fetching jobs...`);

      // Convert datePosted to hours_old for JobSpy
      const hoursOldMap: Record<string, number | undefined> = {
        'today': 24,
        '3days': 72,
        'week': 168,
        'month': 720,
      };
      const hoursOld = hoursOldMap[datePosted || 'month'];

      // Build request body
      const requestBody: Record<string, any> = {
        search_term: query,
        site_name: ['indeed', 'linkedin'],
        results_wanted: limit,
      };

      if (location) {
        requestBody.location = location;
      }
      if (country) {
        requestBody.country_indeed = country;
      }
      if (isRemote !== undefined) {
        requestBody.is_remote = isRemote;
      }
      if (jobType) {
        requestBody.job_type = jobType;
      }
      if (hoursOld !== undefined) {
        requestBody.hours_old = hoursOld;
      }

      // Make request to JobSpy service
      // The JobSpy service will automatically rotate proxies using its proxy pool
      const response = await axios.post(`${this.jobspyUrl}/scrape`, requestBody, {
        timeout: 120000, // 2 minutes
        headers: {
          'X-Worker-Index': proxyIndex.toString(), // For debugging
        },
      });

      const jobs = response.data.jobs || [];
      logger.debug('ParallelCollector', `Worker ${proxyIndex}: Fetched ${jobs.length} jobs`);

      return {
        jobs: jobs.map((job: any) => this.transformJob(job)),
        proxyIndex,
        success: true,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('ParallelCollector', `Worker ${proxyIndex}: Failed - ${errorMsg}`);

      return {
        jobs: [],
        proxyIndex,
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Retry failed workers with exponential backoff
   */
  private async retryFailedWorkers(
    input: ParallelCollectorInput,
    failedWorkers: Array<{ proxyIndex: number; error: string }>
  ): Promise<RawJob[]> {
    logger.info('ParallelCollector', `Retrying ${failedWorkers.length} failed workers...`);

    // Wait a bit before retrying
    await this.sleep(2000);

    const retryTasks = failedWorkers.map(({ proxyIndex }) =>
      this.fetchWithProxy(input, proxyIndex)
    );

    const retryResults = await Promise.allSettled(retryTasks);

    const jobs: RawJob[] = [];
    retryResults.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.success) {
        jobs.push(...result.value.jobs);
        logger.info('ParallelCollector', `Retry worker ${failedWorkers[index].proxyIndex}: Success (${result.value.jobs.length} jobs)`);
      } else {
        logger.warn('ParallelCollector', `Retry worker ${failedWorkers[index].proxyIndex}: Failed again`);
      }
    });

    return jobs;
  }

  /**
   * Deduplicate jobs based on sourceId, job_url, and title+company combination
   */
  private deduplicateJobs(jobs: RawJob[]): RawJob[] {
    const seen = new Set<string>();
    const deduplicated: RawJob[] = [];

    for (const job of jobs) {
      // Create a unique key from sourceId or application URL
      // Fallback to a hash of title+company+location to avoid false collisions
      const key = job.sourceId || 
                  job.applicationUrl || 
                  `${job.title.toLowerCase()}-${job.company.toLowerCase()}-${job.location || 'unknown'}`;

      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(job);
      }
    }

    logger.debug('ParallelCollector', `Deduplicated ${jobs.length} jobs to ${deduplicated.length} unique jobs`);
    return deduplicated;
  }

  /**
   * Transform JobSpy job to RawJob format
   */
  private transformJob(job: any): RawJob {
    const description = (job.description && job.description !== 'nan') ? job.description : '';

    let postedDate: Date | undefined;
    if (job.date_posted && job.date_posted !== 'nan') {
      const parsed = new Date(job.date_posted);
      if (!isNaN(parsed.getTime())) {
        postedDate = parsed;
      }
    }

    return {
      title: job.title || 'Unknown',
      company: job.company || 'Unknown',
      description,
      location: job.location || undefined,
      isRemote: job.is_remote || false,
      salaryMin: job.min_amount ? parseInt(job.min_amount, 10) : undefined,
      salaryMax: job.max_amount ? parseInt(job.max_amount, 10) : undefined,
      salaryCurrency: job.currency || undefined,
      applicationUrl: job.job_url || undefined,
      postedDate,
      source: 'jobspy',
      sourceId: job.id || undefined,
    };
  }

  /**
   * Record successful request for a proxy
   */
  private recordSuccess(proxyIndex: number): void {
    const metrics = this.proxyMetrics.get(proxyIndex) || {
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
    };

    metrics.totalRequests++;
    metrics.successCount++;
    metrics.lastSuccess = Date.now();

    this.proxyMetrics.set(proxyIndex, metrics);
  }

  /**
   * Record failed request for a proxy
   */
  private recordFailure(proxyIndex: number): void {
    const metrics = this.proxyMetrics.get(proxyIndex) || {
      totalRequests: 0,
      successCount: 0,
      failureCount: 0,
    };

    metrics.totalRequests++;
    metrics.failureCount++;
    metrics.lastFailure = Date.now();

    this.proxyMetrics.set(proxyIndex, metrics);
  }

  /**
   * Get metrics for all proxies
   */
  getMetrics(): Map<number, ProxyMetrics> {
    return this.proxyMetrics;
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
