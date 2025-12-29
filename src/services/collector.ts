import axios from 'axios';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import type { RawJob } from '../core/types.js';
import type { IService } from '../core/interfaces.js';

interface CollectorInput {
  query: string;      // Job title + location
  location?: string;
  isRemote?: boolean;
  limit?: number;      // Target number of jobs to fetch
  maxPages?: number;   // Max pages to fetch (each page ~10 jobs)
  source?: 'serpapi' | 'jobspy' | 'all'; // Which source to use
  skipCache?: boolean; // Force fresh fetch
  cacheHours?: number; // How long to cache results (default 6 hours)
}

const JOBS_PER_PAGE = 10;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_CACHE_HOURS = 6;

/**
 * CollectorService - fetches jobs from multiple sources with caching
 */
export class CollectorService implements IService<CollectorInput, RawJob[]> {
  private readonly apiKey: string;

  constructor() {
    this.apiKey = config.SERPAPI_API_KEY;
    logger.info('Collector', 'Initialized with SerpAPI + JobSpy');
  }

  async execute(input: CollectorInput): Promise<RawJob[]> {
    const { source = 'serpapi' } = input;

    if (source === 'all') {
      // Fetch from both sources
      const [serpJobs, jobspyJobs] = await Promise.allSettled([
        this.fetchFromSerpAPI(input),
        this.fetchFromJobSpy(input),
      ]);

      const allJobs: RawJob[] = [];
      if (serpJobs.status === 'fulfilled') allJobs.push(...serpJobs.value);
      if (jobspyJobs.status === 'fulfilled') allJobs.push(...jobspyJobs.value);

      logger.info('Collector', `Combined: ${allJobs.length} jobs from all sources`);
      return allJobs;
    } else if (source === 'jobspy') {
      return this.fetchFromJobSpy(input);
    } else {
      return this.fetchFromSerpAPI(input);
    }
  }

  /**
   * Check if we have cached results for this query
   */
  private async checkCache(queryHash: string): Promise<boolean> {
    const db = getDb();
    const cached = await db.queryCache.findUnique({
      where: { queryHash },
    });

    if (cached && cached.expiresAt > new Date()) {
      logger.info('Collector', `Cache hit: query was fetched ${this.timeAgo(cached.fetchedAt)}, expires ${this.timeAgo(cached.expiresAt)}`);
      return true;
    }
    return false;
  }

  /**
   * Update cache entry after fetching
   */
  private async updateCache(
    queryHash: string,
    query: string,
    location: string | undefined,
    isRemote: boolean,
    source: string,
    jobCount: number,
    cacheHours: number
  ): Promise<void> {
    const db = getDb();
    const expiresAt = new Date(Date.now() + cacheHours * 60 * 60 * 1000);

    await db.queryCache.upsert({
      where: { queryHash },
      create: {
        queryHash,
        query,
        location,
        isRemote,
        source,
        jobCount,
        expiresAt,
      },
      update: {
        jobCount,
        fetchedAt: new Date(),
        expiresAt,
      },
    });
  }

  /**
   * Generate hash for query parameters
   */
  private getQueryHash(query: string, location: string | undefined, isRemote: boolean, source: string): string {
    const data = JSON.stringify({ query, location, isRemote, source });
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  /**
   * Fetch jobs from SerpAPI with caching
   */
  private async fetchFromSerpAPI(input: CollectorInput): Promise<RawJob[]> {
    const {
      query,
      location,
      isRemote = false,
      limit = 1000,
      maxPages = DEFAULT_MAX_PAGES,
      skipCache = false,
      cacheHours = DEFAULT_CACHE_HOURS,
    } = input;

    const queryHash = this.getQueryHash(query, location, isRemote, 'serpapi');

    // Check cache unless skipCache is true
    if (!skipCache) {
      const isCached = await this.checkCache(queryHash);
      if (isCached) {
        // Return jobs from database instead of API
        // Don't filter by location string - the query hash already includes location
        const db = getDb();
        const cachedJobs = await db.job.findMany({
          where: {
            source: 'serpapi',
            ...(isRemote && { isRemote: true }),
          },
          orderBy: { lastSeenAt: 'desc' },
          take: limit,
        });

        logger.info('Collector', `Returning ${cachedJobs.length} cached SerpAPI jobs`);
        return cachedJobs.map(job => ({
          title: job.title,
          company: job.company,
          description: job.description,
          location: job.location ?? undefined,
          isRemote: job.isRemote,
          salaryMin: job.salaryMin ?? undefined,
          salaryMax: job.salaryMax ?? undefined,
          salaryCurrency: job.salaryCurrency ?? undefined,
          applicationUrl: job.applicationUrl ?? undefined,
          postedDate: job.postedDate ?? undefined,
          source: job.source as 'serpapi' | 'jobspy',
          sourceId: job.sourceId ?? undefined,
        }));
      }
    }

    logger.info('Collector', `[SerpAPI] Searching: "${query}" in ${location || 'any location'} (target: ${limit} jobs)`);

    const allJobs: RawJob[] = [];
    let page = 0;
    let nextPageToken: string | undefined;
    let hasMore = true;

    try {
      while (hasMore && page < maxPages && allJobs.length < limit) {
        logger.info('Collector', `[SerpAPI] Fetching page ${page + 1}...`);

        const params: Record<string, string> = {
          engine: 'google_jobs',
          q: query,
          api_key: this.apiKey,
        };

        if (location) params.location = location;
        if (isRemote) params.ltype = '1';
        if (nextPageToken) params.next_page_token = nextPageToken;

        const response = await axios.get('https://serpapi.com/search', { params });

        const jobs = response.data.jobs_results || [];
        logger.info('Collector', `[SerpAPI] Page ${page + 1}: found ${jobs.length} jobs`);

        if (jobs.length === 0) {
          hasMore = false;
          logger.info('Collector', '[SerpAPI] No more jobs available');
        } else {
          for (const job of jobs) {
            if (allJobs.length >= limit) break;
            allJobs.push(this.transformSerpJob(job));
          }

          nextPageToken = response.data.serpapi_pagination?.next_page_token;
          hasMore = !!nextPageToken;
          page++;

          if (!hasMore) {
            logger.info('Collector', '[SerpAPI] No more pages available');
          }

          if (hasMore && allJobs.length < limit) {
            await this.delay(500);
          }
        }
      }

      // Update cache
      await this.updateCache(queryHash, query, location, isRemote, 'serpapi', allJobs.length, cacheHours);

      logger.info('Collector', `[SerpAPI] Total collected: ${allJobs.length} jobs from ${page} pages`);
      return allJobs;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.error('Collector', '[SerpAPI] API error', {
          status: error.response?.status,
          message: error.response?.data?.error,
        });
        if (allJobs.length > 0) {
          logger.warn('Collector', `[SerpAPI] Returning ${allJobs.length} jobs collected before error`);
          return allJobs;
        }
      } else {
        logger.error('Collector', '[SerpAPI] Collection failed', error);
      }
      throw error;
    }
  }

  /**
   * Fetch jobs from JobSpy (Python microservice or direct API)
   */
  private async fetchFromJobSpy(input: CollectorInput): Promise<RawJob[]> {
    const {
      query,
      location,
      isRemote = false,
      limit = 100,
      skipCache = false,
      cacheHours = DEFAULT_CACHE_HOURS,
    } = input;

    const queryHash = this.getQueryHash(query, location, isRemote, 'jobspy');

    // Check cache unless skipCache is true
    if (!skipCache) {
      const isCached = await this.checkCache(queryHash);
      if (isCached) {
        const db = getDb();
        const cachedJobs = await db.job.findMany({
          where: {
            source: 'jobspy',
            ...(isRemote && { isRemote: true }),
          },
          orderBy: { lastSeenAt: 'desc' },
          take: limit,
        });

        logger.info('Collector', `Returning ${cachedJobs.length} cached JobSpy jobs`);
        return cachedJobs.map(job => ({
          title: job.title,
          company: job.company,
          description: job.description,
          location: job.location ?? undefined,
          isRemote: job.isRemote,
          salaryMin: job.salaryMin ?? undefined,
          salaryMax: job.salaryMax ?? undefined,
          salaryCurrency: job.salaryCurrency ?? undefined,
          applicationUrl: job.applicationUrl ?? undefined,
          postedDate: job.postedDate ?? undefined,
          source: job.source as 'serpapi' | 'jobspy',
          sourceId: job.sourceId ?? undefined,
        }));
      }
    }

    // Check if JOBSPY_URL is configured
    const jobspyUrl = process.env.JOBSPY_URL;
    if (!jobspyUrl) {
      logger.warn('Collector', '[JobSpy] JOBSPY_URL not configured, skipping');
      return [];
    }

    logger.info('Collector', `[JobSpy] Searching: "${query}" (target: ${limit} jobs)`);

    try {
      const response = await axios.post(`${jobspyUrl}/scrape`, {
        search_term: query,
        location: location || 'USA',
        site_name: ['indeed', 'linkedin', 'glassdoor'],
        is_remote: isRemote,
        results_wanted: limit,
      }, { timeout: 120000 }); // 2 min timeout for scraping

      const jobs = response.data.jobs || [];
      logger.info('Collector', `[JobSpy] Found ${jobs.length} jobs`);

      const transformedJobs = jobs.map((job: any) => this.transformJobSpyJob(job));

      // Update cache
      await this.updateCache(queryHash, query, location, isRemote, 'jobspy', transformedJobs.length, cacheHours);

      return transformedJobs;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.error('Collector', '[JobSpy] API error', {
          status: error.response?.status,
          message: error.message,
        });
      } else {
        logger.error('Collector', '[JobSpy] Collection failed', error);
      }
      return []; // Return empty array instead of throwing - JobSpy is optional
    }
  }

  private transformSerpJob(serpJob: any): RawJob {
    let salaryMin: number | undefined;
    let salaryMax: number | undefined;
    let salaryCurrency: string | undefined;

    if (serpJob.detected_extensions?.salary) {
      const salary = serpJob.detected_extensions.salary;
      const numbers = salary.match(/[\d,]+/g);
      if (numbers && numbers.length >= 1) {
        salaryMin = parseInt(numbers[0].replace(/,/g, ''));
        if (numbers.length >= 2) {
          salaryMax = parseInt(numbers[1].replace(/,/g, ''));
        }
      }
      salaryCurrency = salary.includes('$') ? 'USD' : undefined;
    }

    const isRemote = Boolean(
      serpJob.detected_extensions?.work_from_home ||
      serpJob.location?.toLowerCase().includes('remote') ||
      serpJob.description?.toLowerCase().includes('remote')
    );

    return {
      title: serpJob.title || 'Unknown',
      company: serpJob.company_name || 'Unknown',
      description: serpJob.description || '',
      location: serpJob.location || undefined,
      isRemote,
      salaryMin,
      salaryMax,
      salaryCurrency,
      applicationUrl: serpJob.apply_link || serpJob.share_link || undefined,
      postedDate: serpJob.detected_extensions?.posted_at
        ? this.parsePostedDate(serpJob.detected_extensions.posted_at)
        : undefined,
      source: 'serpapi',
      sourceId: serpJob.job_id || undefined,
    };
  }

  private transformJobSpyJob(job: any): RawJob {
    return {
      title: job.title || 'Unknown',
      company: job.company || 'Unknown',
      description: job.description || '',
      location: job.location || undefined,
      isRemote: job.is_remote || false,
      salaryMin: job.min_amount ? parseInt(job.min_amount) : undefined,
      salaryMax: job.max_amount ? parseInt(job.max_amount) : undefined,
      salaryCurrency: job.currency || undefined,
      applicationUrl: job.job_url || undefined,
      postedDate: job.date_posted ? new Date(job.date_posted) : undefined,
      source: 'jobspy',
      sourceId: job.id || undefined,
    };
  }

  private parsePostedDate(postedAt: string): Date | undefined {
    const now = new Date();
    const match = postedAt.match(/(\d+)\s+(day|week|month|hour)s?\s+ago/i);

    if (!match) return undefined;

    const [, amount, unit] = match;
    const num = parseInt(amount);

    switch (unit.toLowerCase()) {
      case 'hour':
        now.setHours(now.getHours() - num);
        break;
      case 'day':
        now.setDate(now.getDate() - num);
        break;
      case 'week':
        now.setDate(now.getDate() - num * 7);
        break;
      case 'month':
        now.setMonth(now.getMonth() - num);
        break;
    }

    return now;
  }

  private timeAgo(date: Date): string {
    const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
