import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenRouterKeyPool } from './key-pool.js';

// Mock config module
vi.mock('../config.js', () => ({
  config: {
    OPENROUTER_API_KEY: 'sk-or-test-single-key',
    OPENROUTER_API_KEYS: undefined,
    OPENROUTER_KEY_RATE_LIMIT: 10,
  },
}));

// Mock logger module
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('OpenRouterKeyPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Single Key Mode', () => {
    it('should initialize with single key when OPENROUTER_API_KEYS is not set', () => {
      const pool = new OpenRouterKeyPool();
      expect(pool.totalCapacity).toBe(10); // 1 key × 10 RPM
    });

    it('should provide the same key repeatedly', async () => {
      const pool = new OpenRouterKeyPool();
      const key1 = await pool.getAvailableKey();
      const key2 = await pool.getAvailableKey();

      expect(key1).toBe('sk-or-test-single-key');
      expect(key2).toBe('sk-or-test-single-key');
    });

    it('should track request counts', async () => {
      const pool = new OpenRouterKeyPool();

      // Make 5 requests
      for (let i = 0; i < 5; i++) {
        await pool.getAvailableKey();
      }

      const stats = pool.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].requestCount).toBe(5);
    });

    it('should enforce rate limit', async () => {
      const pool = new OpenRouterKeyPool();

      // Make 10 requests (at limit)
      for (let i = 0; i < 10; i++) {
        const key = await pool.getAvailableKey();
        expect(key).toBeTruthy();
      }

      const stats = pool.getStats();
      expect(stats[0].requestCount).toBe(10);
    });
  });

  describe('Multiple Keys Mode', () => {
    beforeEach(() => {
      // Mock multiple keys
      vi.doMock('../config.js', () => ({
        config: {
          OPENROUTER_API_KEY: 'sk-or-test-fallback',
          OPENROUTER_API_KEYS: 'sk-or-key1,sk-or-key2,sk-or-key3',
          OPENROUTER_KEY_RATE_LIMIT: 10,
        },
      }));
    });

    it('should calculate total capacity correctly', () => {
      // Re-import to get mocked config
      const { OpenRouterKeyPool: Pool } = require('./key-pool.js');
      const pool = new Pool();
      expect(pool.totalCapacity).toBe(30); // 3 keys × 10 RPM
    });

    it('should rotate through keys in round-robin fashion', async () => {
      const { OpenRouterKeyPool: Pool } = require('./key-pool.js');
      const pool = new Pool();

      const key1 = await pool.getAvailableKey();
      const key2 = await pool.getAvailableKey();
      const key3 = await pool.getAvailableKey();
      const key4 = await pool.getAvailableKey();

      expect(key1).toBe('sk-or-key1');
      expect(key2).toBe('sk-or-key2');
      expect(key3).toBe('sk-or-key3');
      expect(key4).toBe('sk-or-key1'); // Cycles back
    });
  });

  describe('429 Blocking', () => {
    it('should mark key as 429-blocked', async () => {
      const pool = new OpenRouterKeyPool();
      const key = await pool.getAvailableKey();

      expect(key).toBeTruthy();
      pool.markKey429(key!);

      const stats = pool.getStats();
      expect(stats[0].is429Blocked).toBe(true);
    });
  });

  describe('Key Masking', () => {
    it('should mask API keys for safe logging', () => {
      const pool = new OpenRouterKeyPool();

      const masked = pool.maskKey('sk-or-v1-1234567890abcdef');
      expect(masked).toBe('***90abcdef');
      expect(masked).not.toContain('1234567890');
    });

    it('should handle short keys', () => {
      const pool = new OpenRouterKeyPool();

      const masked = pool.maskKey('short');
      expect(masked).toBe('***');
    });
  });

  describe('Statistics', () => {
    it('should return masked keys in stats', async () => {
      const pool = new OpenRouterKeyPool();
      await pool.getAvailableKey();

      const stats = pool.getStats();
      expect(stats[0].maskedKey).toContain('***');
      expect(stats[0].maskedKey).not.toContain('sk-or-test-single-key');
    });

    it('should include request count and 429 status', async () => {
      const pool = new OpenRouterKeyPool();
      const key = await pool.getAvailableKey();

      const statsBefore = pool.getStats();
      expect(statsBefore[0].requestCount).toBe(1);
      expect(statsBefore[0].is429Blocked).toBe(false);

      pool.markKey429(key!);

      const statsAfter = pool.getStats();
      expect(statsAfter[0].is429Blocked).toBe(true);
    });
  });

  describe('Sliding Window', () => {
    it('should clean up old timestamps', async () => {
      vi.useFakeTimers();
      const pool = new OpenRouterKeyPool();

      // Make a request
      await pool.getAvailableKey();
      expect(pool.getStats()[0].requestCount).toBe(1);

      // Advance time by 61 seconds (beyond the 60-second window)
      vi.advanceTimersByTime(61000);

      // Make another request - old timestamp should be cleaned up
      await pool.getAvailableKey();
      const stats = pool.getStats();
      expect(stats[0].requestCount).toBe(1); // Only the new request

      vi.useRealTimers();
    });
  });
});
