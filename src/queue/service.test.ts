import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

/**
 * Tests for QueueService in-memory request deduplication cache
 *
 * These tests verify that:
 * 1. Cache keys include all relevant parameters (including limit)
 * 2. Duplicate requests within TTL should share the same cache entry
 * 3. Different parameters produce different cache keys
 * 4. Undefined values use null (consistent with CollectorService)
 */

// Helper to generate collection cache key (same logic as in service.ts)
function getCollectionCacheKey(params: {
  query: string;
  location?: string;
  isRemote?: boolean;
  jobType?: string;
  datePosted?: string;
  source?: string;
  limit?: number;
}): string {
  // Use null for undefined to be consistent with CollectorService
  const keyData = {
    query: params.query,
    location: params.location ?? null,
    isRemote: params.isRemote ?? null,
    jobType: params.jobType ?? null,
    datePosted: params.datePosted ?? null,
    source: params.source ?? 'jobspy',
    limit: params.limit ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(keyData)).digest('hex').substring(0, 16);
}

describe('QueueService Collection Cache Key', () => {
  describe('getCollectionCacheKey', () => {
    it('generates consistent hash for same parameters', () => {
      const key1 = getCollectionCacheKey({
        query: 'Software Engineer',
        location: 'Toronto',
        isRemote: true,
        datePosted: 'today',
        limit: 500,
      });
      const key2 = getCollectionCacheKey({
        query: 'Software Engineer',
        location: 'Toronto',
        isRemote: true,
        datePosted: 'today',
        limit: 500,
      });

      expect(key1).toBe(key2);
    });

    it('generates different hash for different queries', () => {
      const key1 = getCollectionCacheKey({ query: 'Software Engineer', location: 'Toronto' });
      const key2 = getCollectionCacheKey({ query: 'Data Scientist', location: 'Toronto' });

      expect(key1).not.toBe(key2);
    });

    it('generates different hash for different datePosted', () => {
      const keyToday = getCollectionCacheKey({ query: 'Engineer', datePosted: 'today' });
      const keyMonth = getCollectionCacheKey({ query: 'Engineer', datePosted: 'month' });

      expect(keyToday).not.toBe(keyMonth);
    });

    it('generates different hash for different jobType', () => {
      const keyFulltime = getCollectionCacheKey({ query: 'Engineer', jobType: 'fulltime' });
      const keyContract = getCollectionCacheKey({ query: 'Engineer', jobType: 'contract' });

      expect(keyFulltime).not.toBe(keyContract);
    });

    it('generates different hash for different isRemote values', () => {
      const keyRemote = getCollectionCacheKey({ query: 'Engineer', isRemote: true });
      const keyOnsite = getCollectionCacheKey({ query: 'Engineer', isRemote: false });
      const keyAny = getCollectionCacheKey({ query: 'Engineer' }); // undefined = null

      expect(keyRemote).not.toBe(keyOnsite);
      expect(keyRemote).not.toBe(keyAny);
      expect(keyOnsite).not.toBe(keyAny);
    });

    it('generates different hash for different limit values', () => {
      const key500 = getCollectionCacheKey({ query: 'Engineer', limit: 500 });
      const key1000 = getCollectionCacheKey({ query: 'Engineer', limit: 1000 });
      const keyNoLimit = getCollectionCacheKey({ query: 'Engineer' }); // undefined = null

      expect(key500).not.toBe(key1000);
      expect(key500).not.toBe(keyNoLimit);
      expect(key1000).not.toBe(keyNoLimit);
    });

    it('treats undefined values as null (not as false or empty string)', () => {
      // undefined isRemote should NOT match false
      const keyUndefinedRemote = getCollectionCacheKey({ query: 'Engineer' });
      const keyFalseRemote = getCollectionCacheKey({ query: 'Engineer', isRemote: false });
      expect(keyUndefinedRemote).not.toBe(keyFalseRemote);

      // undefined location should NOT match empty string
      const keyUndefinedLocation = getCollectionCacheKey({ query: 'Engineer' });
      const keyEmptyLocation = getCollectionCacheKey({ query: 'Engineer', location: '' });
      expect(keyUndefinedLocation).not.toBe(keyEmptyLocation);
    });
  });
});

describe('Request Deduplication Scenarios', () => {
  it('same subscription running twice quickly should have same cache key', () => {
    // Simulating same query being run twice in quick succession
    const run1 = getCollectionCacheKey({
      query: 'Frontend Developer',
      location: 'San Francisco',
      isRemote: false,
      datePosted: 'today',
      source: 'jobspy',
      limit: 500,
    });
    const run2 = getCollectionCacheKey({
      query: 'Frontend Developer',
      location: 'San Francisco',
      isRemote: false,
      datePosted: 'today',
      source: 'jobspy',
      limit: 500,
    });

    expect(run1).toBe(run2);
  });

  it('two subscriptions with same search should share cache', () => {
    // User A and User B both search for same job
    const userA = getCollectionCacheKey({
      query: 'Machine Learning Engineer',
      location: 'Remote',
      isRemote: true,
      datePosted: 'week',
      limit: 500,
    });
    const userB = getCollectionCacheKey({
      query: 'Machine Learning Engineer',
      location: 'Remote',
      isRemote: true,
      datePosted: 'week',
      limit: 500,
    });

    expect(userA).toBe(userB);
  });

  it('two subscriptions with different datePosted should NOT share cache', () => {
    const userA = getCollectionCacheKey({
      query: 'Machine Learning Engineer',
      location: 'Remote',
      isRemote: true,
      datePosted: 'month', // First run backfill
      limit: 1000,
    });
    const userB = getCollectionCacheKey({
      query: 'Machine Learning Engineer',
      location: 'Remote',
      isRemote: true,
      datePosted: 'today', // Subsequent scheduled run
      limit: 500,
    });

    expect(userA).not.toBe(userB);
  });

  it('two subscriptions with different limits should NOT share cache', () => {
    const manualScan = getCollectionCacheKey({
      query: 'Developer',
      datePosted: 'month',
      limit: 1000, // Manual scan limit
    });
    const scheduledScan = getCollectionCacheKey({
      query: 'Developer',
      datePosted: 'month',
      limit: 500, // Scheduled scan limit
    });

    expect(manualScan).not.toBe(scheduledScan);
  });

  it('location variants should have different cache keys', () => {
    // Toronto vs Toronto, ON vs Toronto, Canada
    const toronto1 = getCollectionCacheKey({ query: 'Developer', location: 'Toronto' });
    const toronto2 = getCollectionCacheKey({ query: 'Developer', location: 'Toronto, ON' });
    const toronto3 = getCollectionCacheKey({ query: 'Developer', location: 'Toronto, Canada' });

    expect(toronto1).not.toBe(toronto2);
    expect(toronto2).not.toBe(toronto3);
    expect(toronto1).not.toBe(toronto3);
  });
});

describe('Cache Key Length', () => {
  it('generates 16 character hex string', () => {
    const key = getCollectionCacheKey({
      query: 'Test Query',
      location: 'Test Location',
    });

    expect(key).toHaveLength(16);
    expect(/^[0-9a-f]+$/.test(key)).toBe(true);
  });

  it('always generates 16 characters regardless of input length', () => {
    const shortKey = getCollectionCacheKey({ query: 'A' });
    const longKey = getCollectionCacheKey({
      query: 'A very long job title that contains many words and characters',
      location: 'A very long location string with city, province, and country details',
      jobType: 'fulltime',
      datePosted: 'month',
      limit: 1000,
    });

    expect(shortKey).toHaveLength(16);
    expect(longKey).toHaveLength(16);
  });
});
