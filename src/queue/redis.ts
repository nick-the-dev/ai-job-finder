import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let redisClient: Redis | null = null;
let isRedisAvailable = false;
let connectionFailed = false; // Suppress repeated error logs after initial failure

export function getRedis(): Redis | null {
  return redisClient;
}

export function isRedisConnected(): boolean {
  return isRedisAvailable;
}

export async function initRedis(): Promise<boolean> {
  try {
    redisClient = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        if (times > 3) {
          return null; // Stop retrying - error will be logged in catch block
        }
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    redisClient.on('error', (err: Error) => {
      if (!connectionFailed) {
        logger.warn('Redis', 'Connection error', err.message);
      }
      isRedisAvailable = false;
    });

    redisClient.on('connect', () => {
      logger.info('Redis', 'Connected');
      isRedisAvailable = true;
    });

    redisClient.on('close', () => {
      logger.debug('Redis', 'Connection closed');
      isRedisAvailable = false;
    });

    // Test connection
    await redisClient.connect();
    await redisClient.ping();
    isRedisAvailable = true;
    logger.info('Redis', `Connected to ${config.REDIS_URL}`);
    return true;
  } catch (error) {
    connectionFailed = true; // Suppress further error logs
    logger.warn('Redis', 'Failed to connect - using fallback mode', error instanceof Error ? error.message : 'Unknown error');
    isRedisAvailable = false;
    // Properly disconnect to stop retry attempts
    if (redisClient) {
      try {
        redisClient.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
    redisClient = null;
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch {
      // Ignore errors on disconnect
    }
    redisClient = null;
    isRedisAvailable = false;
    logger.info('Redis', 'Disconnected');
  }
}

// Run cancellation tracking
// When a run is stopped/failed, we mark it as cancelled so workers can skip processing
const CANCELLED_RUNS_KEY = 'cancelled_runs';
const CANCELLATION_TTL_SECONDS = 3600; // 1 hour - plenty of time for queued jobs to see it

/**
 * Mark a run as cancelled so workers will skip jobs for this run
 */
export async function markRunCancelled(runId: string): Promise<boolean> {
  if (!redisClient || !isRedisAvailable) {
    logger.warn('Redis', `Cannot mark run ${runId} as cancelled - Redis not available`);
    return false;
  }

  try {
    // Use a hash with TTL per runId
    const key = `${CANCELLED_RUNS_KEY}:${runId}`;
    await redisClient.setex(key, CANCELLATION_TTL_SECONDS, '1');
    logger.info('Redis', `🛑 Run ${runId} marked as CANCELLED - workers will skip remaining jobs`);
    return true;
  } catch (error) {
    logger.error('Redis', `Failed to mark run ${runId} as cancelled`, error);
    return false;
  }
}

/**
 * Check if a run has been cancelled
 */
export async function isRunCancelled(runId: string): Promise<boolean> {
  if (!runId) return false;
  if (!redisClient || !isRedisAvailable) {
    return false; // If Redis is down, allow jobs to proceed
  }

  try {
    const key = `${CANCELLED_RUNS_KEY}:${runId}`;
    const result = await redisClient.get(key);
    return result === '1';
  } catch (error) {
    logger.warn('Redis', `Failed to check cancellation for run ${runId}`, error);
    return false; // On error, allow jobs to proceed
  }
}
