import axios from 'axios';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { getDb } from '../db/client.js';
import type { RawJob } from '../core/types.js';
import type { IService } from '../core/interfaces.js';
import type { Job } from '@prisma/client';

interface CollectorInput {
  query: string;      // Job title + location
  location?: string;
  isRemote?: boolean;
  jobType?: 'fulltime' | 'parttime' | 'internship' | 'contract'; // Filter by job type
  limit?: number;      // Target number of jobs to fetch
  maxPages?: number;   // Max pages to fetch (each page ~10 jobs)
  source?: 'serpapi' | 'jobspy' | 'all'; // Which source to use
  skipCache?: boolean; // Force fresh fetch
  cacheHours?: number; // How long to cache results (default 6 hours)
  datePosted?: 'today' | '3days' | 'week' | 'month'; // Filter by posting date
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
    isRemote: boolean | undefined,
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
        isRemote: isRemote ?? false, // DB requires boolean, use false for "all"
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
  private getQueryHash(query: string, location: string | undefined, isRemote: boolean | undefined, source: string): string {
    // Use null in JSON for undefined to distinguish from false
    const data = JSON.stringify({ query, location, isRemote: isRemote ?? null, source });
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }

  /**
   * Fetch jobs from SerpAPI with caching
   */
  private async fetchFromSerpAPI(input: CollectorInput): Promise<RawJob[]> {
    const {
      query,
      location,
      isRemote, // undefined = all jobs, true = remote only, false = on-site only
      limit = 1000,
      maxPages = DEFAULT_MAX_PAGES,
      skipCache = false,
      cacheHours = DEFAULT_CACHE_HOURS,
      datePosted = 'month', // Default to last 30 days
    } = input;

    const queryHash = this.getQueryHash(query, location, isRemote, 'serpapi');

    // Check cache unless skipCache is true
    if (!skipCache) {
      const isCached = await this.checkCache(queryHash);
      if (isCached) {
        const db = getDb();

        // Build location filter for cached results
        const locationLower = location?.toLowerCase();
        const locationFilter = (location && locationLower !== 'remote') ? {
          location: { contains: location.split(',')[0].trim(), mode: 'insensitive' as const }
        } : {};

        // Build remote filter: undefined = all, true = remote only, false = on-site only
        const remoteFilter = isRemote !== undefined ? { isRemote } : {};

        const cachedJobs = await db.job.findMany({
          where: {
            source: 'serpapi',
            ...remoteFilter,
            ...locationFilter,
          },
          orderBy: { lastSeenAt: 'desc' },
          take: limit,
        });

        logger.info('Collector', `[SerpAPI] Cache hit: ${cachedJobs.length} jobs for "${query}" in "${location || 'any'}"`);

        return cachedJobs.map((job: Job) => ({
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

    const allJobs: RawJob[] = [];
    let page = 0;
    let nextPageToken: string | undefined;
    let hasMore = true;

    try {
      while (hasMore && page < maxPages && allJobs.length < limit) {

        const params: Record<string, string> = {
          engine: 'google_jobs',
          q: query,
          api_key: this.apiKey,
          hl: 'en', // Force English results to avoid localized text (Arabic, etc.)
        };

        // Don't pass "Remote" as location - it's not a valid SerpAPI location
        // "Remote" is handled via ltype parameter instead (fix v3 - 2024-12-29)
        const locationLower = location?.toLowerCase();
        if (location && locationLower !== 'remote') {
          params.location = location;
        }
        if (isRemote) params.ltype = '1';
        if (nextPageToken) params.next_page_token = nextPageToken;

        // Date filter: today, 3days, week, month
        if (datePosted) {
          params.chips = `date_posted:${datePosted}`;
        }

        const response = await axios.get('https://serpapi.com/search', { params });

        const jobs = response.data.jobs_results || [];

        if (jobs.length === 0) {
          hasMore = false;
        } else {
          for (const job of jobs) {
            if (allJobs.length >= limit) break;
            allJobs.push(this.transformSerpJob(job));
          }

          nextPageToken = response.data.serpapi_pagination?.next_page_token;
          hasMore = !!nextPageToken;
          page++;

          if (hasMore && allJobs.length < limit) {
            await this.delay(500);
          }
        }
      }

      // Update cache
      await this.updateCache(queryHash, query, location, isRemote, 'serpapi', allJobs.length, cacheHours);

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
      isRemote, // undefined = all jobs, true = remote only, false = on-site only
      jobType,  // fulltime, parttime, internship, contract
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

        // Build location filter for cached results
        const locationFilter = location ? {
          location: { contains: location.split(',')[0].trim(), mode: 'insensitive' as const }
        } : {};

        // Build remote filter: undefined = all, true = remote only, false = on-site only
        const remoteFilter = isRemote !== undefined ? { isRemote } : {};

        const cachedJobs = await db.job.findMany({
          where: {
            source: 'jobspy',
            ...remoteFilter,
            ...locationFilter,
          },
          orderBy: { lastSeenAt: 'desc' },
          take: limit,
        });

        logger.info('Collector', `[JobSpy] Cache hit: ${cachedJobs.length} jobs for "${query}" in "${location || 'any'}"`);

        return cachedJobs.map((job: Job) => ({
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

    // Convert datePosted to hours_old for JobSpy
    // Default: 720 hours (30 days / 1 month)
    const hoursOldMap: Record<string, number | undefined> = {
      'today': 24,
      '3days': 72,
      'week': 168,
      'month': 720,
      'all': undefined, // No limit - fetch all available
    };
    // Default to 720 (month) if not specified
    const hoursOld = input.datePosted ? hoursOldMap[input.datePosted] : 720;

    try {
      // Indeed limitation: only one of (hours_old) OR (job_type & is_remote) can be used
      // Solution: If both are needed, do multiple searches and intersect results
      const needsMultipleSearches = (hoursOld !== undefined) && (jobType || isRemote !== undefined);

      if (needsMultipleSearches) {
        logger.info('Collector', `[JobSpy] Using multiple searches due to Indeed limitation`);
        const jobs = await this.fetchJobSpyWithIntersection(
          query,
          location || 'USA',
          limit,
          hoursOld,
          jobType,
          isRemote
        );
        await this.updateCache(queryHash, query, location, isRemote, 'jobspy', jobs.length, cacheHours);
        return jobs;
      }

      // Single search - no conflicting filters
      const requestBody: Record<string, any> = {
        search_term: query,
        location: location || 'USA',
        site_name: ['indeed', 'linkedin'],  // glassdoor disabled - location parsing broken
        results_wanted: limit,
      };
      // Only add is_remote if explicitly set (undefined = all jobs)
      if (isRemote !== undefined) {
        requestBody.is_remote = isRemote;
      }
      // Only add job_type if explicitly set (undefined = all types)
      if (jobType) {
        requestBody.job_type = jobType;
      }
      // Only add hours_old if specified (undefined = no limit / all time)
      if (hoursOld !== undefined) {
        requestBody.hours_old = hoursOld;
      }

      const response = await axios.post(`${jobspyUrl}/scrape`, requestBody, { timeout: 120000 }); // 2 min timeout for scraping

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

    const isRemote = this.detectRemote(
      serpJob.detected_extensions?.work_from_home,
      serpJob.location,
      serpJob.description
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
    // Filter out Python "nan" string from description
    const description = (job.description && job.description !== 'nan') ? job.description : '';

    // Validate date - ensure it's not "nan", null, or creates an Invalid Date
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
      salaryMin: job.min_amount ? parseInt(job.min_amount) : undefined,
      salaryMax: job.max_amount ? parseInt(job.max_amount) : undefined,
      salaryCurrency: job.currency || undefined,
      applicationUrl: job.job_url || undefined,
      postedDate,
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

  /**
   * Detect if a job is truly remote using multiple signals
   * Avoids false positives from incidental "remote" mentions in descriptions
   */
  private detectRemote(
    workFromHomeFlag: boolean | undefined,
    location: string | undefined,
    description: string | undefined
  ): boolean {
    // Most reliable: SerpAPI's work_from_home extension
    if (workFromHomeFlag) return true;

    // Check location field (usually reliable)
    const locationLower = location?.toLowerCase() || '';
    if (locationLower.includes('remote') || locationLower.includes('work from home')) {
      return true;
    }

    // Check description with strict patterns to avoid false positives
    const descLower = description?.toLowerCase() || '';

    // Strong indicators that this IS a remote position
    const remotePatterns = [
      /\bremote\s+(position|role|job|work|opportunity)/,   // "remote position", "remote role"
      /\b(fully|100%|completely)\s+remote\b/,               // "fully remote", "100% remote"
      /\bwork\s+(from\s+)?home\b/,                          // "work from home", "work home"
      /\bremote[\s-]first\b/,                               // "remote-first"
      /\bremote[\s-]only\b/,                                // "remote only"
      /\bremote\s+friendly\b/,                              // "remote friendly"
      /\blocation:\s*remote\b/,                             // "location: remote"
      /\bthis\s+is\s+a\s+remote\b/,                         // "this is a remote"
      /\bcan\s+work\s+remotely\b/,                          // "can work remotely"
      /\bwork\s+remotely\s+(from\s+)?anywhere\b/,           // "work remotely from anywhere"
    ];

    for (const pattern of remotePatterns) {
      if (pattern.test(descLower)) {
        return true;
      }
    }

    // NOT remote: mentions like "remote debugging", "remote teams", "support remote"
    return false;
  }

  /**
   * Handle Indeed limitation: only one of (hours_old) OR (job_type & is_remote) can be used
   * Solution: Do multiple searches and intersect results
   *
   * Search 1: with hours_old → gets recent jobs (any type)
   * Search 2: with job_type & is_remote → gets specific type (any date)
   * Result: intersection of both (jobs that match BOTH criteria)
   */
  private async fetchJobSpyWithIntersection(
    query: string,
    location: string,
    limit: number,
    hoursOld: number | undefined,
    jobType: string | undefined,
    isRemote: boolean | undefined
  ): Promise<RawJob[]> {
    const jobspyUrl = process.env.JOBSPY_URL;
    if (!jobspyUrl) return [];

    // Request more results since we'll be filtering down
    const expandedLimit = Math.min(limit * 3, 500);

    // Search 1: Filter by date (hours_old)
    const dateRequest: Record<string, any> = {
      search_term: query,
      location,
      site_name: ['indeed', 'linkedin'],
      results_wanted: expandedLimit,
    };
    if (hoursOld !== undefined) {
      dateRequest.hours_old = hoursOld;
    }

    logger.info('Collector', `[JobSpy] Search 1: date filter (hours_old=${hoursOld})`);
    const dateResponse = await axios.post(`${jobspyUrl}/scrape`, dateRequest, { timeout: 120000 });
    const dateJobs = dateResponse.data.jobs || [];
    logger.info('Collector', `[JobSpy] Search 1 found ${dateJobs.length} recent jobs`);

    // Search 2: Filter by job_type and/or is_remote
    const typeRequest: Record<string, any> = {
      search_term: query,
      location,
      site_name: ['indeed', 'linkedin'],
      results_wanted: expandedLimit,
    };
    if (jobType) {
      typeRequest.job_type = jobType;
    }
    if (isRemote !== undefined) {
      typeRequest.is_remote = isRemote;
    }

    // Small delay between requests to be nice to the API
    await this.delay(500);

    logger.info('Collector', `[JobSpy] Search 2: type filter (job_type=${jobType}, is_remote=${isRemote})`);
    const typeResponse = await axios.post(`${jobspyUrl}/scrape`, typeRequest, { timeout: 120000 });
    const typeJobs = typeResponse.data.jobs || [];
    logger.info('Collector', `[JobSpy] Search 2 found ${typeJobs.length} type-filtered jobs`);

    // Build a set of job URLs from the type-filtered search for fast lookup
    const typeJobUrls = new Set(
      typeJobs.map((job: any) => job.job_url).filter(Boolean)
    );

    // Intersect: keep only date-filtered jobs that also appear in type-filtered results
    const intersectedJobs = dateJobs.filter((job: any) =>
      job.job_url && typeJobUrls.has(job.job_url)
    );

    logger.info('Collector', `[JobSpy] Intersection: ${intersectedJobs.length} jobs match both filters`);

    // Transform and limit results
    const transformedJobs = intersectedJobs
      .slice(0, limit)
      .map((job: any) => this.transformJobSpyJob(job));

    return transformedJobs;
  }
}
