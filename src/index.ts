import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { router, errorHandler } from './api/routes.js';
import { getDb, disconnectDb } from './db/client.js';
import { initBot, stopBot } from './telegram/bot.js';
import { initScheduler, stopScheduler } from './scheduler/cron.js';

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

// Request logging
app.use((req, res, next) => {
  logger.info('HTTP', `${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/', router);

// Error handler
app.use(errorHandler);

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info('Server', `${signal} received, shutting down...`);
  stopScheduler();
  await stopBot();
  await disconnectDb();
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

    // Initialize Telegram bot (if configured)
    if (config.TELEGRAM_BOT_TOKEN) {
      logger.info('Server', 'Initializing Telegram bot...');
      await initBot(app);
    } else {
      logger.info('Server', 'Telegram bot disabled (no TELEGRAM_BOT_TOKEN)');
    }

    // Initialize scheduler for hourly job searches
    initScheduler();

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
    });
  } catch (error) {
    logger.error('Server', 'Failed to start', error);
    process.exit(1);
  }
}

start();
