/**
 * OpenRouter API Key Pool
 *
 * Manages multiple OpenRouter API keys with rate limiting and automatic rotation.
 * Tracks request counts per key with a sliding window to enforce rate limits.
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';

interface KeyStats {
  key: string;
  requestTimestamps: number[]; // Timestamps of requests in the sliding window
  is429Blocked: boolean; // Temporarily blocked due to 429 error
  blockedUntil?: number; // Timestamp when the block expires
}

export class OpenRouterKeyPool {
  private keys: KeyStats[] = [];
  private currentIndex: number = 0;
  private readonly rateLimit: number;

  constructor() {
    this.rateLimit = config.OPENROUTER_KEY_RATE_LIMIT;

    // Load keys from config
    if (config.OPENROUTER_API_KEYS) {
      // Multiple keys configured - use key pool
      const keysList = config.OPENROUTER_API_KEYS.split(',').map(k => k.trim()).filter(k => k);
      this.keys = keysList.map(key => ({
        key,
        requestTimestamps: [],
        is429Blocked: false,
      }));
      logger.info('KeyPool', `Initialized with ${this.keys.length} keys (rate limit: ${this.rateLimit} RPM per key)`);
    } else {
      // Fall back to single key
      this.keys = [{
        key: config.OPENROUTER_API_KEY,
        requestTimestamps: [],
        is429Blocked: false,
      }];
      logger.info('KeyPool', `Initialized with single key (rate limit: ${this.rateLimit} RPM)`);
    }
  }

  /**
   * Get total capacity of the key pool (number of keys × rate limit)
   */
  get totalCapacity(): number {
    return this.keys.length * this.rateLimit;
  }

  /**
   * Get an available API key that's under its rate limit.
   * Returns null if all keys are exhausted.
   */
  async getAvailableKey(): Promise<string | null> {
    const now = Date.now();
    const oneMinuteAgo = now - 60000; // 1 minute sliding window

    // Clean up old timestamps and unblock keys that were 429-blocked
    for (const keyStats of this.keys) {
      // Remove timestamps older than 1 minute
      keyStats.requestTimestamps = keyStats.requestTimestamps.filter(ts => ts > oneMinuteAgo);

      // Check if 429 block has expired (wait 60 seconds after 429)
      if (keyStats.is429Blocked && keyStats.blockedUntil && now > keyStats.blockedUntil) {
        keyStats.is429Blocked = false;
        keyStats.blockedUntil = undefined;
        logger.info('KeyPool', `Key ${this.maskKey(keyStats.key)} unblocked after 429 cooldown`);
      }
    }

    // Try to find an available key (round-robin + availability check)
    const startIndex = this.currentIndex;
    let attempts = 0;

    while (attempts < this.keys.length) {
      const keyStats = this.keys[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
      attempts++;

      // Skip if blocked by 429
      if (keyStats.is429Blocked) {
        continue;
      }

      // Check if key is under rate limit
      if (keyStats.requestTimestamps.length < this.rateLimit) {
        // Record this request
        keyStats.requestTimestamps.push(now);
        return keyStats.key;
      }
    }

    // All keys exhausted
    logger.warn('KeyPool', `All ${this.keys.length} keys are at rate limit or blocked. Waiting...`);

    // Calculate when the next key will be available
    const nextAvailableTime = this.getNextAvailableTime();
    if (nextAvailableTime > 0) {
      logger.info('KeyPool', `Next key available in ${Math.ceil(nextAvailableTime / 1000)}s`);
      await this.sleep(nextAvailableTime);
      return this.getAvailableKey(); // Try again after waiting
    }

    return null;
  }

  /**
   * Mark a key as temporarily unavailable due to 429 error
   */
  markKey429(key: string): void {
    const keyStats = this.keys.find(k => k.key === key);
    if (keyStats) {
      keyStats.is429Blocked = true;
      keyStats.blockedUntil = Date.now() + 60000; // Block for 60 seconds
      logger.warn('KeyPool', `Key ${this.maskKey(key)} marked as 429-blocked for 60s`);
    }
  }

  /**
   * Get statistics for all keys
   */
  getStats(): Array<{ maskedKey: string; requestCount: number; is429Blocked: boolean }> {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    return this.keys.map(keyStats => ({
      maskedKey: this.maskKey(keyStats.key),
      requestCount: keyStats.requestTimestamps.filter(ts => ts > oneMinuteAgo).length,
      is429Blocked: keyStats.is429Blocked,
    }));
  }

  /**
   * Mask API key for safe logging (show only last 8 characters)
   */
  maskKey(key: string): string {
    if (key.length <= 8) {
      return '***';
    }
    return `***${key.slice(-8)}`;
  }

  /**
   * Calculate time until next key becomes available
   */
  private getNextAvailableTime(): number {
    const now = Date.now();
    let minWaitTime = Infinity;

    for (const keyStats of this.keys) {
      if (keyStats.is429Blocked && keyStats.blockedUntil) {
        // Key is blocked, calculate when it will be unblocked
        const waitTime = keyStats.blockedUntil - now;
        minWaitTime = Math.min(minWaitTime, waitTime);
      } else if (keyStats.requestTimestamps.length >= this.rateLimit) {
        // Key is at rate limit, calculate when oldest request expires
        const oldestTimestamp = keyStats.requestTimestamps[0];
        const waitTime = (oldestTimestamp + 60000) - now;
        minWaitTime = Math.min(minWaitTime, waitTime);
      } else {
        // Key is available now
        return 0;
      }
    }

    return minWaitTime === Infinity ? 0 : Math.max(0, minWaitTime);
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
