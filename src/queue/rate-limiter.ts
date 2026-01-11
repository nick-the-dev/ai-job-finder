/**
 * Smart Rate Limiter for Job Collection
 *
 * Handles LinkedIn's aggressive rate limiting with exponential backoff.
 * LinkedIn is much stricter than Indeed - typically returns 429 after 10-20 rapid requests.
 *
 * Best practices from LinkedIn:
 * - Rate limits reset at midnight UTC
 * - After 429, need 30-60 second cooldown minimum
 * - Exponential backoff with jitter prevents thundering herd
 * - Proxy rotation helps but doesn't eliminate rate limits
 */

import { logger } from '../utils/logger.js';
import { config } from '../config.js';

interface RateLimitState {
  consecutive429s: number;
  lastRequestTime: number;
  lastErrorTime: number;
  inCooldown: boolean;
  cooldownUntil: number;
  totalRequests: number;
  total429s: number;
}

interface RateLimitConfig {
  // Base delay between requests (ms)
  baseDelayMs: number;
  // Maximum delay after many 429s (ms)
  maxDelayMs: number;
  // Multiplier for exponential backoff
  backoffMultiplier: number;
  // How many 429s before entering cooldown mode
  cooldownThreshold: number;
  // Cooldown duration (ms)
  cooldownDurationMs: number;
  // Delay after each successful request to avoid hitting limits (ms)
  successDelayMs: number;
}

// Source-specific rate limit configurations
const SOURCE_CONFIGS: Record<string, RateLimitConfig> = {
  // LinkedIn is very aggressive - need conservative limits
  linkedin: {
    baseDelayMs: 3000,         // 3 seconds between requests minimum
    maxDelayMs: 120000,        // 2 minute max backoff
    backoffMultiplier: 2,      // Double delay on each 429
    cooldownThreshold: 3,      // Enter cooldown after 3 consecutive 429s
    cooldownDurationMs: 60000, // 1 minute cooldown
    successDelayMs: 2000,      // 2 second delay after success
  },
  // Indeed is more lenient
  indeed: {
    baseDelayMs: 1000,         // 1 second between requests
    maxDelayMs: 30000,         // 30 second max backoff
    backoffMultiplier: 1.5,    // 1.5x delay on each 429
    cooldownThreshold: 5,      // Enter cooldown after 5 consecutive 429s
    cooldownDurationMs: 30000, // 30 second cooldown
    successDelayMs: 500,       // 0.5 second delay after success
  },
  // Default for unknown sources
  default: {
    baseDelayMs: 2000,
    maxDelayMs: 60000,
    backoffMultiplier: 2,
    cooldownThreshold: 3,
    cooldownDurationMs: 45000,
    successDelayMs: 1000,
  },
};

/**
 * Global rate limiter that tracks rate limit state across all requests.
 * Uses singleton pattern to maintain state across queue workers.
 */
class CollectionRateLimiter {
  private sourceStates: Map<string, RateLimitState> = new Map();
  private globalState: RateLimitState;

  constructor() {
    this.globalState = this.createInitialState();
    logger.info('RateLimiter', 'Initialized with source-specific rate limiting');
  }

  private createInitialState(): RateLimitState {
    return {
      consecutive429s: 0,
      lastRequestTime: 0,
      lastErrorTime: 0,
      inCooldown: false,
      cooldownUntil: 0,
      totalRequests: 0,
      total429s: 0,
    };
  }

  private getSourceState(source: string): RateLimitState {
    if (!this.sourceStates.has(source)) {
      this.sourceStates.set(source, this.createInitialState());
    }
    return this.sourceStates.get(source)!;
  }

  private getConfig(source: string): RateLimitConfig {
    return SOURCE_CONFIGS[source] || SOURCE_CONFIGS.default;
  }

  /**
   * Calculate the delay needed before making a request to the given source.
   * Returns 0 if no delay needed.
   */
  getRequiredDelay(source: string = 'default'): number {
    const state = this.getSourceState(source);
    const cfg = this.getConfig(source);
    const now = Date.now();

    // Check if in cooldown
    if (state.inCooldown && now < state.cooldownUntil) {
      const remaining = state.cooldownUntil - now;
      logger.warn('RateLimiter', `[${source}] In cooldown, ${Math.round(remaining / 1000)}s remaining`);
      return remaining;
    }

    // Exit cooldown if time has passed
    if (state.inCooldown && now >= state.cooldownUntil) {
      state.inCooldown = false;
      state.consecutive429s = 0;
      logger.info('RateLimiter', `[${source}] Exited cooldown mode`);
    }

    // Calculate delay based on consecutive 429s (exponential backoff)
    let delay = cfg.baseDelayMs;
    if (state.consecutive429s > 0) {
      delay = Math.min(
        cfg.baseDelayMs * Math.pow(cfg.backoffMultiplier, state.consecutive429s),
        cfg.maxDelayMs
      );
      // Add jitter to prevent thundering herd (±20%)
      delay = delay * (0.8 + Math.random() * 0.4);
    }

    // Ensure minimum delay since last request
    const timeSinceLastRequest = now - state.lastRequestTime;
    const minDelay = state.consecutive429s > 0 ? delay : cfg.successDelayMs;

    if (timeSinceLastRequest < minDelay) {
      return minDelay - timeSinceLastRequest;
    }

    return 0;
  }

  /**
   * Wait for the required delay before making a request.
   * Returns the actual wait time in ms.
   */
  async waitForSlot(source: string = 'default'): Promise<number> {
    const delay = this.getRequiredDelay(source);
    if (delay > 0) {
      logger.debug('RateLimiter', `[${source}] Waiting ${Math.round(delay)}ms before request`);
      await this.sleep(delay);
    }
    return delay;
  }

  /**
   * Record a successful request. Reduces backoff state.
   */
  recordSuccess(source: string = 'default'): void {
    const state = this.getSourceState(source);
    state.totalRequests++;
    state.lastRequestTime = Date.now();

    // Gradually reduce consecutive429s on success (but keep some memory)
    if (state.consecutive429s > 0) {
      state.consecutive429s = Math.max(0, state.consecutive429s - 1);
      logger.debug('RateLimiter', `[${source}] Success, consecutive429s now: ${state.consecutive429s}`);
    }
  }

  /**
   * Record a 429 rate limit error. Increases backoff state.
   */
  record429(source: string = 'default'): void {
    const state = this.getSourceState(source);
    const cfg = this.getConfig(source);
    const now = Date.now();

    state.totalRequests++;
    state.total429s++;
    state.consecutive429s++;
    state.lastErrorTime = now;
    state.lastRequestTime = now;

    logger.warn('RateLimiter', `[${source}] 429 recorded, consecutive: ${state.consecutive429s}, total: ${state.total429s}`);

    // Check if we should enter cooldown
    if (state.consecutive429s >= cfg.cooldownThreshold) {
      state.inCooldown = true;
      state.cooldownUntil = now + cfg.cooldownDurationMs;
      logger.warn('RateLimiter', `[${source}] Entering cooldown mode for ${cfg.cooldownDurationMs / 1000}s (consecutive 429s: ${state.consecutive429s})`);
    }
  }

  /**
   * Record a generic error (not 429). Slight backoff.
   */
  recordError(source: string = 'default', errorMessage?: string): void {
    const state = this.getSourceState(source);
    state.totalRequests++;
    state.lastRequestTime = Date.now();

    // Only increase backoff slightly for non-429 errors
    if (state.consecutive429s < 2) {
      state.consecutive429s = Math.min(state.consecutive429s + 0.5, 2);
    }

    logger.debug('RateLimiter', `[${source}] Error recorded: ${errorMessage || 'unknown'}`);
  }

  /**
   * Check if the error message indicates a 429 rate limit.
   */
  is429Error(errorMessage: string): boolean {
    const patterns = [
      /429/,
      /too\s*many\s*requests/i,
      /rate\s*limit/i,
      /throttl/i,
      /quota/i,
    ];
    return patterns.some(p => p.test(errorMessage));
  }

  /**
   * Get current state for a source (for monitoring/debugging).
   */
  getState(source: string = 'default'): RateLimitState {
    return { ...this.getSourceState(source) };
  }

  /**
   * Get state for all sources (for monitoring/debugging).
   */
  getAllStates(): Record<string, RateLimitState> {
    const result: Record<string, RateLimitState> = {
      global: { ...this.globalState },
    };
    for (const [source, state] of this.sourceStates) {
      result[source] = { ...state };
    }
    return result;
  }

  /**
   * Reset state for a source (use with caution).
   */
  reset(source?: string): void {
    if (source) {
      this.sourceStates.delete(source);
      logger.info('RateLimiter', `Reset state for source: ${source}`);
    } else {
      this.sourceStates.clear();
      this.globalState = this.createInitialState();
      logger.info('RateLimiter', 'Reset all state');
    }
  }

  /**
   * Get the recommended delay between any two collection requests.
   * This is the global minimum delay regardless of source.
   */
  getGlobalMinDelay(): number {
    // Configurable via environment, default 1 second
    return config.COLLECTION_MIN_DELAY_MS || 1000;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton instance
export const rateLimiter = new CollectionRateLimiter();
