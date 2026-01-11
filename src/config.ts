import { z } from 'zod';
import { config as dotenvConfig } from 'dotenv';
import { logger } from './utils/logger.js';

dotenvConfig();

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Redis (optional - queue falls back to in-process if unavailable)
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Queue concurrency limits
  QUEUE_JOBSPY_CONCURRENCY: z.coerce.number().default(2),
  QUEUE_LLM_CONCURRENCY: z.coerce.number().default(5),
  QUEUE_FALLBACK_ENABLED: z.coerce.boolean().default(true),

  // Scheduling
  SUBSCRIPTION_INTERVAL_HOURS: z.coerce.number().default(1),

  // OpenRouter
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_API_KEYS: z.string().optional(), // Comma-separated API keys for key pool
  OPENROUTER_KEY_RATE_LIMIT: z.coerce.number().default(10), // Requests per minute per key
  OPENROUTER_MODEL: z.string().default('xiaomi/mimo-v2-flash:free'),

  // SerpAPI
  SERPAPI_API_KEY: z.string().min(1),

  // JobSpy
  JOBSPY_PROXIES: z.string().optional(), // Comma-separated proxy URLs
  JOBSPY_PARALLEL_ENABLED: z.coerce.boolean().default(false),
  JOBSPY_PARALLEL_WORKERS: z.coerce.number().default(10),

  // Rate Limiting for Job Collection
  // LinkedIn is aggressive - needs conservative limits to avoid 429s
  COLLECTION_MIN_DELAY_MS: z.coerce.number().default(1500),      // Minimum delay between any collection requests (ms)
  COLLECTION_LINKEDIN_DELAY_MS: z.coerce.number().default(3000), // Delay between LinkedIn requests (ms)
  COLLECTION_INDEED_DELAY_MS: z.coerce.number().default(1000),   // Delay between Indeed requests (ms)
  COLLECTION_MAX_QUERIES_PER_RUN: z.coerce.number().default(100), // Max queries per subscription run (prevents overload)

  // Server
  PORT: z.string().default('3000').transform(Number),
  APP_URL: z.string().url().optional(), // Base URL for download links (e.g., https://app.example.com)

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Telegram Bot (optional - bot only starts if token is set)
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  // Observability & Admin
  OBSERVABILITY_RETENTION_DAYS: z.coerce.number().default(30),
  ADMIN_API_KEY: z.string().min(32).optional(), // Min 32 chars for security

  // Langfuse (LLM observability - optional)
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_BASE_URL: z.string().url().default('https://langfuse.49-12-207-132.sslip.io'), // Self-hosted Langfuse

  // Sentry (error tracking - optional)
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().default('development'),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  SENTRY_PROFILES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
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
