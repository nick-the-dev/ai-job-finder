import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

/**
 * Tests for CollectorService caching functionality
 *
 * These tests verify that:
 * 1. Cache keys include all relevant parameters (query, location, isRemote, datePosted, jobType)
 * 2. Different datePosted values produce different cache keys
 * 3. Different jobType values produce different cache keys
 * 4. Date filters are correctly applied when returning cached jobs
 */

// Helper to generate cache key (same logic as in collector.ts)
function getQueryHash(
  query: string,
  location: string | undefined,
  isRemote: boolean | undefined,
  source: string,
  datePosted?: string,
  jobType?: string
): string {
  const data = JSON.stringify({
    query,
    location,
    isRemote: isRemote ?? null,
    source,
    datePosted: datePosted ?? null,
    jobType: jobType ?? null,
  });
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
}

// Helper to build date filter (same logic as in collector.ts)
function getDateFilter(datePosted: string): Record<string, any> {
  const now = new Date();
  let cutoffDate: Date;

  switch (datePosted) {
    case 'today':
      cutoffDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case '3days':
      cutoffDate = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      break;
    case 'week':
      cutoffDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'month':
      cutoffDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    default:
      return {};
  }

  return {
    OR: [
      { postedDate: { gte: cutoffDate } },
      { postedDate: null },
    ],
  };
}

describe('CollectorService Cache Key Generation', () => {
  describe('getQueryHash', () => {
    it('generates consistent hash for same parameters', () => {
      const hash1 = getQueryHash('Software Engineer', 'Toronto', true, 'jobspy', 'today', 'fulltime');
      const hash2 = getQueryHash('Software Engineer', 'Toronto', true, 'jobspy', 'today', 'fulltime');

      expect(hash1).toBe(hash2);
    });

    it('generates different hash for different queries', () => {
      const hash1 = getQueryHash('Software Engineer', 'Toronto', true, 'jobspy');
      const hash2 = getQueryHash('Data Scientist', 'Toronto', true, 'jobspy');

      expect(hash1).not.toBe(hash2);
    });

    it('generates different hash for different locations', () => {
      const hash1 = getQueryHash('Software Engineer', 'Toronto', true, 'jobspy');
      const hash2 = getQueryHash('Software Engineer', 'Vancouver', true, 'jobspy');

      expect(hash1).not.toBe(hash2);
    });

    it('generates different hash for different isRemote values', () => {
      const hashRemote = getQueryHash('Software Engineer', 'Toronto', true, 'jobspy');
      const hashOnsite = getQueryHash('Software Engineer', 'Toronto', false, 'jobspy');
      const hashAny = getQueryHash('Software Engineer', 'Toronto', undefined, 'jobspy');

      expect(hashRemote).not.toBe(hashOnsite);
      expect(hashRemote).not.toBe(hashAny);
      expect(hashOnsite).not.toBe(hashAny);
    });

    it('generates different hash for different datePosted values', () => {
      const hashToday = getQueryHash('Software Engineer', 'Toronto', true, 'jobspy', 'today');
      const hash3days = getQueryHash('Software Engineer', 'Toronto', true, 'jobspy', '3days');
      const hashWeek = getQueryHash('Software Engineer', 'Toronto', true, 'jobspy', 'week');
      const hashMonth = getQueryHash('Software Engineer', 'Toronto', true, 'jobspy', 'month');

      // All should be different
      const hashes = [hashToday, hash3days, hashWeek, hashMonth];
      const uniqueHashes = new Set(hashes);

      expect(uniqueHashes.size).toBe(4);
    });

    it('generates different hash for different jobType values', () => {
      const hashFulltime = getQueryHash('Software Engineer', 'Toronto', true, 'jobspy', 'today', 'fulltime');
      const hashParttime = getQueryHash('Software Engineer', 'Toronto', true, 'jobspy', 'today', 'parttime');
      const hashContract = getQueryHash('Software Engineer', 'Toronto', true, 'jobspy', 'today', 'contract');
      const hashNoType = getQueryHash('Software Engineer', 'Toronto', true, 'jobspy', 'today', undefined);

      const hashes = [hashFulltime, hashParttime, hashContract, hashNoType];
      const uniqueHashes = new Set(hashes);

      expect(uniqueHashes.size).toBe(4);
    });

    it('generates different hash for different sources', () => {
      const hashJobspy = getQueryHash('Software Engineer', 'Toronto', true, 'jobspy');
      const hashSerpapi = getQueryHash('Software Engineer', 'Toronto', true, 'serpapi');

      expect(hashJobspy).not.toBe(hashSerpapi);
    });

    it('handles undefined location consistently', () => {
      const hash1 = getQueryHash('Software Engineer', undefined, true, 'jobspy');
      const hash2 = getQueryHash('Software Engineer', undefined, true, 'jobspy');

      expect(hash1).toBe(hash2);
    });

    it('treats undefined location differently from empty string', () => {
      // undefined is serialized as null in JSON, empty string stays as ""
      // These should produce different hashes to prevent cache collisions
      const hashUndefined = getQueryHash('Software Engineer', undefined, true, 'jobspy');
      const hashEmpty = getQueryHash('Software Engineer', '', true, 'jobspy');

      expect(hashUndefined).not.toBe(hashEmpty);
    });
  });
});

describe('CollectorService Date Filter', () => {
  describe('getDateFilter', () => {
    it('returns empty object for "all" datePosted', () => {
      const filter = getDateFilter('all');
      expect(filter).toEqual({});
    });

    it('returns empty object for unknown datePosted', () => {
      const filter = getDateFilter('unknown');
      expect(filter).toEqual({});
    });

    it('returns correct filter structure for "today"', () => {
      const filter = getDateFilter('today');

      expect(filter).toHaveProperty('OR');
      expect(filter.OR).toHaveLength(2);
      expect(filter.OR[0]).toHaveProperty('postedDate');
      expect(filter.OR[0].postedDate).toHaveProperty('gte');
      expect(filter.OR[1]).toEqual({ postedDate: null });
    });

    it('returns correct filter structure for "week"', () => {
      const filter = getDateFilter('week');

      expect(filter).toHaveProperty('OR');
      expect(filter.OR[0].postedDate.gte).toBeInstanceOf(Date);
    });

    it('returns correct filter structure for "month"', () => {
      const filter = getDateFilter('month');

      expect(filter).toHaveProperty('OR');
      expect(filter.OR[0].postedDate.gte).toBeInstanceOf(Date);
    });

    it('calculates correct cutoff for "today" (24 hours)', () => {
      const now = Date.now();
      const filter = getDateFilter('today');
      const cutoff = filter.OR[0].postedDate.gte.getTime();

      // Should be approximately 24 hours ago (with some tolerance for test execution time)
      const expectedCutoff = now - 24 * 60 * 60 * 1000;
      expect(Math.abs(cutoff - expectedCutoff)).toBeLessThan(1000); // Within 1 second
    });

    it('calculates correct cutoff for "3days" (72 hours)', () => {
      const now = Date.now();
      const filter = getDateFilter('3days');
      const cutoff = filter.OR[0].postedDate.gte.getTime();

      const expectedCutoff = now - 3 * 24 * 60 * 60 * 1000;
      expect(Math.abs(cutoff - expectedCutoff)).toBeLessThan(1000);
    });

    it('calculates correct cutoff for "week" (7 days)', () => {
      const now = Date.now();
      const filter = getDateFilter('week');
      const cutoff = filter.OR[0].postedDate.gte.getTime();

      const expectedCutoff = now - 7 * 24 * 60 * 60 * 1000;
      expect(Math.abs(cutoff - expectedCutoff)).toBeLessThan(1000);
    });

    it('calculates correct cutoff for "month" (30 days)', () => {
      const now = Date.now();
      const filter = getDateFilter('month');
      const cutoff = filter.OR[0].postedDate.gte.getTime();

      const expectedCutoff = now - 30 * 24 * 60 * 60 * 1000;
      expect(Math.abs(cutoff - expectedCutoff)).toBeLessThan(1000);
    });
  });
});

describe('Global/Worldwide Search', () => {
  describe('Cache key generation for global search', () => {
    it('generates consistent hash for global search (undefined location)', () => {
      // Global search should have consistent cache key
      const hash1 = getQueryHash('Software Engineer', undefined, true, 'jobspy', 'week');
      const hash2 = getQueryHash('Software Engineer', undefined, true, 'jobspy', 'week');

      expect(hash1).toBe(hash2);
    });

    it('generates different hash for global vs location-specific search', () => {
      // Global search (undefined) vs specific location should be different
      const globalHash = getQueryHash('Software Engineer', undefined, true, 'jobspy', 'week');
      const usaHash = getQueryHash('Software Engineer', 'United States', true, 'jobspy', 'week');
      const canadaHash = getQueryHash('Software Engineer', 'Canada', true, 'jobspy', 'week');

      expect(globalHash).not.toBe(usaHash);
      expect(globalHash).not.toBe(canadaHash);
      expect(usaHash).not.toBe(canadaHash);
    });

    it('treats undefined location as global search in cache', () => {
      // Undefined location = global search (LinkedIn searches globally, Indeed uses default)
      const hash = getQueryHash('DevOps Engineer', undefined, true, 'jobspy');

      // Should be a valid hash (16 char hex string)
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });

    it('worldwide remote search has unique cache key', () => {
      // User wants remote jobs from anywhere in the world
      const worldwideRemote = getQueryHash('Backend Developer', undefined, true, 'jobspy', 'week');

      // User wants remote jobs from specific countries
      const usRemote = getQueryHash('Backend Developer', 'United States', true, 'jobspy', 'week');
      const ukRemote = getQueryHash('Backend Developer', 'United Kingdom', true, 'jobspy', 'week');

      // All should be different
      const hashes = [worldwideRemote, usRemote, ukRemote];
      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBe(3);
    });
  });

  describe('Global search behavior', () => {
    it('treats empty string location differently from undefined', () => {
      // Empty string might mean user cleared location vs undefined meaning global
      const emptyHash = getQueryHash('Software Engineer', '', true, 'jobspy');
      const undefinedHash = getQueryHash('Software Engineer', undefined, true, 'jobspy');

      expect(emptyHash).not.toBe(undefinedHash);
    });

    it('supports global search with job type filter', () => {
      // Global search can still filter by job type
      const globalFulltime = getQueryHash('Software Engineer', undefined, true, 'jobspy', 'week', 'fulltime');
      const globalContract = getQueryHash('Software Engineer', undefined, true, 'jobspy', 'week', 'contract');
      const globalNoType = getQueryHash('Software Engineer', undefined, true, 'jobspy', 'week', undefined);

      const hashes = [globalFulltime, globalContract, globalNoType];
      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBe(3);
    });

    it('supports global search with date filter', () => {
      // Global search can still filter by date
      const globalToday = getQueryHash('Software Engineer', undefined, true, 'jobspy', 'today');
      const globalWeek = getQueryHash('Software Engineer', undefined, true, 'jobspy', 'week');
      const globalMonth = getQueryHash('Software Engineer', undefined, true, 'jobspy', 'month');

      const hashes = [globalToday, globalWeek, globalMonth];
      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBe(3);
    });
  });
});

describe('Cache Key Isolation', () => {
  it('ensures subscription A with datePosted=month has different cache than subscription B with datePosted=today', () => {
    // This is the key scenario: two subscriptions for the same job search
    // but with different date filters should NOT share cache
    const subscriptionA = getQueryHash('Software Engineer', 'Toronto, Canada', true, 'jobspy', 'month');
    const subscriptionB = getQueryHash('Software Engineer', 'Toronto, Canada', true, 'jobspy', 'today');

    expect(subscriptionA).not.toBe(subscriptionB);
  });

  it('ensures first run (month) and subsequent run (today) have different caches', () => {
    // First run uses user's datePosted setting
    const firstRunHash = getQueryHash('Data Scientist', 'Remote', true, 'jobspy', 'month', 'fulltime');

    // Subsequent scheduled runs use 'today'
    const subsequentRunHash = getQueryHash('Data Scientist', 'Remote', true, 'jobspy', 'today', 'fulltime');

    expect(firstRunHash).not.toBe(subsequentRunHash);
  });

  it('ensures same query across subscriptions shares cache when parameters match', () => {
    // Two subscriptions with identical search parameters SHOULD share cache
    const subscription1 = getQueryHash('Backend Developer', 'New York', false, 'jobspy', 'today');
    const subscription2 = getQueryHash('Backend Developer', 'New York', false, 'jobspy', 'today');

    expect(subscription1).toBe(subscription2);
  });
});
