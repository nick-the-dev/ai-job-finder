import express from 'express';
import rateLimit from 'express-rate-limit';
import * as Sentry from '@sentry/node';
import { createRequire } from 'module';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { router, errorHandler } from './api/routes.js';
import { getDb, disconnectDb } from './db/client.js';
import { initBot, stopBot } from './telegram/bot.js';
import { initScheduler, stopScheduler, handleInterruptedRuns } from './scheduler/cron.js';
import {
  initRedis,
  disconnectRedis,
  initQueues,
  closeQueues,
  startCollectionWorker,
  startMatchingWorker,
  queueService,
} from './queue/index.js';
import { adminRouter } from './admin/index.js';
import { startCleanupScheduler, stopCleanupScheduler } from './observability/index.js';
import { shutdownLangfuse } from './llm/client.js';

// Load package.json for version info
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// Initialize Sentry for error tracking (must be done before Express app)
if (config.SENTRY_DSN) {
  const release = `ai-job-finder@${pkg.version}`;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT,
    release,
    serverName: process.env.HOSTNAME || `ai-job-finder-${process.pid}`,

    // Enable Sentry Logs (requires SDK v9.41.0+)
    enableLogs: true,

    // Integrations for enhanced monitoring
    integrations: [
      Sentry.prismaIntegration(),
    ],

    // Dynamic sampling: critical paths at 100%, health checks at 1%
    tracesSampler: ({ name, parentSampled }) => {
      if (parentSampled) return true;
      if (name?.includes('/health')) return 0.01;
      if (name?.includes('/admin')) return 0.5;
      if (name?.includes('subscription-run') || name?.includes('job-matching')) return 1.0;
      return config.SENTRY_TRACES_SAMPLE_RATE;
    },
    profilesSampleRate: config.SENTRY_PROFILES_SAMPLE_RATE,

    // Filter and enrich events before sending
    beforeSend(event, hint) {
      // Scrub PII from resume text
      if (event.extra) {
        if ('resumeText' in event.extra) {
          event.extra.resumeText = '[REDACTED]';
        }
        if ('resume' in event.extra) {
          event.extra.resume = '[REDACTED]';
        }
      }
      // Don't send expected rate limit errors
      const message = event.message || (hint.originalException as Error)?.message || '';
      if (message.includes('rate limit') || message.includes('Too many requests')) {
        return null;
      }
      return event;
    },

    // Filter noisy breadcrumbs
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.category === 'console' && breadcrumb.level === 'debug') {
        return null;
      }
      return breadcrumb;
    },

    // Debug metrics emission (remove after verification)
    beforeSendMetric(metric) {
      logger.debug('Sentry:Metric', `${metric.name}: ${JSON.stringify(metric)}`);
      return metric;
    },
  });
  logger.info('Sentry', `Enabled (release: ${release})`);
} else {
  logger.info('Sentry', 'Disabled (no SENTRY_DSN configured)');
}

// Global error handlers for uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Process', 'Uncaught exception', error);
  Sentry.captureException(error, {
    tags: { handler: 'uncaughtException' },
  });
  // Flush and exit
  Sentry.close(2000).finally(() => {
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Process', 'Unhandled rejection', reason);
  Sentry.captureException(reason, {
    tags: { handler: 'unhandledRejection' },
  });
});

const app = express();

// Trust proxy for rate limiting behind reverse proxy
app.set('trust proxy', 1);

// Middleware
app.use(express.json());

// Note: CSV exports are now served via /download/:token endpoint with auth
// Static /exports directory is NOT exposed for security

// Rate limiting - different limits for different endpoints
const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 searches per minute
  message: { error: 'Too many search requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('RateLimit', `Search rate limit exceeded: ${req.ip}`);
    res.status(429).json({ error: 'Too many search requests, please try again later' });
  },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute for general API
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('RateLimit', `API rate limit exceeded: ${req.ip}`);
    res.status(429).json({ error: 'Too many requests, please try again later' });
  },
});

// Apply rate limiting (search is more restrictive)
app.use('/search', searchLimiter);
app.use('/jobs', apiLimiter);
app.use('/matches', apiLimiter);
app.use('/download', apiLimiter);

// Note: Sentry v8+ auto-instruments Express, no manual request handler needed

// Request logging
app.use((req, res, next) => {
  logger.info('HTTP', `${req.method} ${req.path}`);
  next();
});

// Admin routes (with built-in security middleware)
app.use('/admin', adminRouter);

// Routes
app.use('/', router);

// Sentry error handler (must be before other error middleware)
if (config.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// Error handler
app.use(errorHandler);

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info('Server', `${signal} received, shutting down...`);
  stopScheduler();
  stopCleanupScheduler();
  queueService.shutdown(); // Stop cache cleanup interval
  await stopBot();
  await closeQueues();
  await disconnectRedis();
  await disconnectDb();
  await shutdownLangfuse(); // Flush and close Langfuse

  // Flush Sentry before exit
  if (config.SENTRY_DSN) {
    await Sentry.close(2000);
    logger.info('Sentry', 'Flushed pending events');
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Start server
async function start() {
  try {
    logger.info('Server', '=== AI Job Finder Starting ===');

    // Test database connection
    logger.info('Server', 'Testing database connection...');
    const db = getDb();
    await db.$queryRaw`SELECT 1`;
    logger.info('Server', 'Database connected');

    // Initialize Redis and queue system
    logger.info('Server', 'Initializing queue system...');
    const redisOk = await initRedis();
    if (redisOk) {
      const queuesOk = await initQueues();
      if (queuesOk) {
        startCollectionWorker();
        startMatchingWorker();
        logger.info('Server', 'Queue workers started');
      }
    } else {
      logger.warn('Server', 'Redis unavailable - using fallback mode (in-process rate limiting)');
    }

    // Initialize Telegram bot (if configured)
    if (config.TELEGRAM_BOT_TOKEN) {
      logger.info('Server', 'Initializing Telegram bot...');
      await initBot(app);
    } else {
      logger.info('Server', 'Telegram bot disabled (no TELEGRAM_BOT_TOKEN)');
    }

    // Initialize scheduler for hourly job searches
    initScheduler();

    // Handle any runs that were interrupted by previous restart
    await handleInterruptedRuns();
    logger.info('Server', 'Checked for interrupted runs');

    // Start observability cleanup scheduler
    startCleanupScheduler();

    // Start listening
    app.listen(config.PORT, () => {
      logger.info('Server', `Listening on port ${config.PORT}`);
      logger.info('Server', '=== Ready for requests ===');
      logger.info('Server', 'Endpoints:');
      logger.info('Server', '  GET  /health  - Health check');
      logger.info('Server', '  POST /search  - Search and match jobs');
      logger.info('Server', '  GET  /jobs    - List collected jobs');
      logger.info('Server', '  GET  /matches - List job matches');
      if (config.TELEGRAM_BOT_TOKEN) {
        logger.info('Server', '  POST /telegram/webhook - Telegram bot webhook');
      }
      if (config.ADMIN_API_KEY) {
        logger.info('Server', '  GET  /admin   - Admin dashboard (requires X-Admin-Key header)');
      } else {
        logger.info('Server', '  Admin dashboard disabled (no ADMIN_API_KEY set)');
      }
    });
  } catch (error) {
    logger.error('Server', 'Failed to start', error);
    process.exit(1);
  }
}

start();
