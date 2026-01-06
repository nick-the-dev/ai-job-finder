import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

/**
 * Tests for QueueService in-memory request deduplication cache
 *
 * These tests verify that:
 * 1. Cache keys include all relevant parameters
 * 2. Duplicate requests within TTL should share the same cache entry
 * 3. Different parameters produce different cache keys
 */

// Helper to generate collection cache key (same logic as in service.ts)
function getCollectionCacheKey(params: {
  query: string;
  location?: string;
  isRemote?: boolean;
  jobType?: string;
  datePosted?: string;
  source?: string;
}): string {
  const keyData = {
    query: params.query,
    location: params.location ?? '',
    isRemote: params.isRemote ?? false,
    jobType: params.jobType ?? '',
    datePosted: params.datePosted ?? '',
    source: params.source ?? 'jobspy',
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
      });
      const key2 = getCollectionCacheKey({
        query: 'Software Engineer',
        location: 'Toronto',
        isRemote: true,
        datePosted: 'today',
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

      expect(keyRemote).not.toBe(keyOnsite);
    });

    it('treats undefined isRemote as false for consistency', () => {
      const keyUndefined = getCollectionCacheKey({ query: 'Engineer' });
      const keyFalse = getCollectionCacheKey({ query: 'Engineer', isRemote: false });

      expect(keyUndefined).toBe(keyFalse);
    });

    it('treats undefined location as empty string', () => {
      const keyUndefined = getCollectionCacheKey({ query: 'Engineer' });
      const keyEmpty = getCollectionCacheKey({ query: 'Engineer', location: '' });

      expect(keyUndefined).toBe(keyEmpty);
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
    });
    const run2 = getCollectionCacheKey({
      query: 'Frontend Developer',
      location: 'San Francisco',
      isRemote: false,
      datePosted: 'today',
      source: 'jobspy',
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
    });
    const userB = getCollectionCacheKey({
      query: 'Machine Learning Engineer',
      location: 'Remote',
      isRemote: true,
      datePosted: 'week',
    });

    expect(userA).toBe(userB);
  });

  it('two subscriptions with different datePosted should NOT share cache', () => {
    const userA = getCollectionCacheKey({
      query: 'Machine Learning Engineer',
      location: 'Remote',
      isRemote: true,
      datePosted: 'month', // First run backfill
    });
    const userB = getCollectionCacheKey({
      query: 'Machine Learning Engineer',
      location: 'Remote',
      isRemote: true,
      datePosted: 'today', // Subsequent scheduled run
    });

    expect(userA).not.toBe(userB);
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
    });

    expect(shortKey).toHaveLength(16);
    expect(longKey).toHaveLength(16);
  });
});
