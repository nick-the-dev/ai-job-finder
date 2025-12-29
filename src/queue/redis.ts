import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let redisClient: Redis | null = null;
let isRedisAvailable = false;

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
          logger.warn('Redis', `Connection failed after ${times} attempts`);
          return null; // Stop retrying
        }
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    redisClient.on('error', (err: Error) => {
      logger.warn('Redis', 'Connection error', err.message);
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
    logger.warn('Redis', 'Failed to connect - using fallback mode', error instanceof Error ? error.message : 'Unknown error');
    isRedisAvailable = false;
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
