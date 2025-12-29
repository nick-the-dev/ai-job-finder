import express from 'express';
import { join } from 'path';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { router, errorHandler } from './api/routes.js';
import { getDb, disconnectDb } from './db/client.js';

const app = express();

// Middleware
app.use(express.json());

// Serve CSV exports
app.use('/exports', express.static(join(process.cwd(), 'exports')));

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

    // Start listening
    app.listen(config.PORT, () => {
      logger.info('Server', `Listening on port ${config.PORT}`);
      logger.info('Server', '=== Ready for requests ===');
      logger.info('Server', 'Endpoints:');
      logger.info('Server', '  GET  /health  - Health check');
      logger.info('Server', '  POST /search  - Search and match jobs');
      logger.info('Server', '  GET  /jobs    - List collected jobs');
      logger.info('Server', '  GET  /matches - List job matches');
    });
  } catch (error) {
    logger.error('Server', 'Failed to start', error);
    process.exit(1);
  }
}

start();
