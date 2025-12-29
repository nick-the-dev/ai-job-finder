import { z } from 'zod';
import { config as dotenvConfig } from 'dotenv';
import { logger } from './utils/logger.js';

dotenvConfig();

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Redis (optional for now)
  REDIS_URL: z.string().optional(),

  // OpenRouter
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().default('xiaomi/mimo-v2-flash:free'),

  // SerpAPI
  SERPAPI_API_KEY: z.string().min(1),

  // Server
  PORT: z.string().default('3000').transform(Number),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

function loadConfig() {
  logger.info('Config', 'Loading environment variables...');

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    logger.error('Config', 'Invalid environment variables', result.error.format());
    process.exit(1);
  }

  logger.info('Config', 'Environment loaded successfully');
  return result.data;
}

export const config = loadConfig();
export type Config = z.infer<typeof envSchema>;
