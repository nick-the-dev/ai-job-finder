import { Router, Request, Response, NextFunction } from 'express';
import express from 'express';
import { getDb } from '../db/client.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { RunTracker } from '../observability/tracker.js';
import { isSubscriptionRunning, releaseSubscriptionLock } from '../scheduler/cron.js';
import { isRedisConnected, getRedis } from '../queue/redis.js';
import { queueService } from '../queue/service.js';
import { getQueues } from '../queue/queues.js';

const router = Router();

// Get directory for serving static files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const adminUiPath = path.join(__dirname, '../../admin-ui/dist');

// Simple in-memory rate limiter
const rateLimiter = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 30; // requests per minute
const RATE_WINDOW = 60 * 1000; // 1 minute

function getRateLimitKey(req: Request): string {
  return req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
}

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimiter.set(key, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }

  if (entry.count >= RATE_LIMIT) {
    return false;
  }

  entry.count++;
  return true;
}

// Cleanup old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimiter.entries()) {
    if (now > entry.resetAt) {
      rateLimiter.delete(key);
    }
  }
}, 60 * 1000);

function computeStatus(isActive: boolean, isPaused: boolean): string {
  if (!isActive) return 'inactive';
  if (isPaused) return 'paused';
  return 'active';
}

// Period configurations for time-based queries
type Period = '24h' | '7d' | '30d' | 'all';

function getPeriodRange(period: Period): { start: Date | null; end: Date } {
  const now = new Date();
  switch (period) {
    case '24h':
      return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now };
    case '7d':
      return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now };
    case '30d':
      return { start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), end: now };
    case 'all':
      return { start: null, end: now };
  }
}

function getPreviousPeriodRange(period: Period): { start: Date | null; end: Date } | null {
  if (period === 'all') return null; // Can't compare "all time"

  const now = new Date();
  const periodMs = period === '24h' ? 24 * 60 * 60 * 1000
                 : period === '7d' ? 7 * 24 * 60 * 60 * 1000
                 : 30 * 24 * 60 * 60 * 1000;

  return {
    start: new Date(now.getTime() - 2 * periodMs),
    end: new Date(now.getTime() - periodMs)
  };
}

function parsePeriod(periodStr: string | undefined): Period {
  if (periodStr === '7d' || periodStr === '30d' || periodStr === 'all') {
    return periodStr;
  }
  return '24h'; // default
}

// Security middleware
function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  // Check if admin is configured
  if (!config.ADMIN_API_KEY) {
    logger.warn('Admin', 'Admin access attempted but ADMIN_API_KEY not configured');
    res.status(503).json({ error: 'Admin dashboard not configured' });
    return;
  }

  // Check rate limit
  const rateLimitKey = getRateLimitKey(req);
  if (!checkRateLimit(rateLimitKey)) {
    logger.warn('Admin', `Rate limit exceeded for ${rateLimitKey}`);
    res.status(429).json({ error: 'Too many requests. Try again later.' });
    return;
  }

  // Validate admin key
  const providedKey = req.header('X-Admin-Key');
  if (providedKey !== config.ADMIN_API_KEY) {
    logger.warn('Admin', `Invalid admin key attempt from ${rateLimitKey}`);
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  logger.debug('Admin', `Admin access granted to ${rateLimitKey}`);
  next();
}

// Serve static files for React SPA (no auth required for assets)
router.use(express.static(adminUiPath));

// Apply security middleware to API routes only
router.use('/api', requireAdminKey);

// Helper to fetch activity metrics for a given time range
async function getActivityMetrics(db: ReturnType<typeof getDb>, start: Date | null, end: Date) {
  const dateFilter = start ? { gte: start, lte: end } : { lte: end };

  const [jobsScanned, matchesFound, notificationsSent, totalRuns, failedRuns] = await Promise.all([
    db.subscriptionRun.aggregate({
      where: { startedAt: dateFilter },
      _sum: { jobsCollected: true },
    }),
    db.jobMatch.count({
      where: { createdAt: dateFilter },
    }),
    db.subscriptionRun.aggregate({
      where: { startedAt: dateFilter },
      _sum: { notificationsSent: true },
    }),
    db.subscriptionRun.count({ where: { startedAt: dateFilter } }),
    db.subscriptionRun.count({
      where: { startedAt: dateFilter, status: 'failed' },
    }),
  ]);

  return {
    jobsScanned: jobsScanned._sum.jobsCollected ?? 0,
    matchesFound,
    notificationsSent: notificationsSent._sum.notificationsSent ?? 0,
    totalRuns,
    failedRuns,
  };
}

// GET /admin/api/overview - Platform summary
// Query params:
//   - period: '24h' | '7d' | '30d' | 'all' (default: '24h')
//   - compare: 'true' to include previous period comparison
router.get('/api/overview', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const period = parsePeriod(req.query.period as string);
    const includeComparison = req.query.compare === 'true';

    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const { start: periodStart, end: periodEnd } = getPeriodRange(period);

    // Get base stats (always needed)
    const [
      totalUsers,
      activeToday,
      newThisWeek,
      activeSubscriptions,
      pausedSubscriptions,
    ] = await Promise.all([
      db.telegramUser.count(),
      db.telegramUser.count({ where: { lastActiveAt: { gte: oneDayAgo } } }),
      db.telegramUser.count({ where: { createdAt: { gte: oneWeekAgo } } }),
      db.searchSubscription.count({ where: { isActive: true, isPaused: false } }),
      db.searchSubscription.count({ where: { isActive: true, isPaused: true } }),
    ]);

    // Total is sum of active + paused (excludes deleted/inactive subscriptions)
    const totalSubscriptions = activeSubscriptions + pausedSubscriptions;

    // Get activity metrics for selected period
    const activityMetrics = await getActivityMetrics(db, periodStart, periodEnd);

    // Build response
    const response: Record<string, unknown> = {
      users: {
        total: totalUsers,
        activeToday,
        newThisWeek,
      },
      subscriptions: {
        total: totalSubscriptions,
        active: activeSubscriptions,
        paused: pausedSubscriptions,
      },
      activity: {
        ...activityMetrics,
        period,
        periodLabel: period === 'all' ? 'All Time' : `Last ${period}`,
      },
      timestamp: now.toISOString(),
    };

    // Add comparison if requested
    if (includeComparison) {
      const prevRange = getPreviousPeriodRange(period);
      if (prevRange) {
        const prevMetrics = await getActivityMetrics(db, prevRange.start, prevRange.end);

        const calcChange = (current: number, previous: number): number | null => {
          if (previous === 0) return current > 0 ? 100 : null;
          return Math.round(((current - previous) / previous) * 100);
        };

        response.comparison = {
          period: `Previous ${period}`,
          activity: prevMetrics,
          changes: {
            jobsScanned: calcChange(activityMetrics.jobsScanned, prevMetrics.jobsScanned),
            matchesFound: calcChange(activityMetrics.matchesFound, prevMetrics.matchesFound),
            notificationsSent: calcChange(activityMetrics.notificationsSent, prevMetrics.notificationsSent),
            totalRuns: calcChange(activityMetrics.totalRuns, prevMetrics.totalRuns),
            failedRuns: calcChange(activityMetrics.failedRuns, prevMetrics.failedRuns),
          },
        };
      }
    }

    res.json(response);
  } catch (error) {
    logger.error('Admin', 'Failed to get overview', error);
    res.status(500).json({ error: 'Failed to get overview' });
  }
});

// GET /admin/api/users - All users with subscription stats
router.get('/api/users', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    const [users, total] = await Promise.all([
      db.telegramUser.findMany({
        skip: offset,
        take: limit,
        orderBy: { lastActiveAt: 'desc' },
        select: {
          id: true,
          telegramId: true,
          username: true,
          firstName: true,
          createdAt: true,
          lastActiveAt: true,
        },
      }),
      db.telegramUser.count(),
    ]);

    // Get subscription stats for each user (only count isActive: true subscriptions)
    const usersWithStats = await Promise.all(
      users.map(async (user) => {
        const [activeSubsCount, totalSubsCount] = await Promise.all([
          db.searchSubscription.count({
            where: { userId: user.id, isActive: true, isPaused: false },
          }),
          db.searchSubscription.count({
            where: { userId: user.id, isActive: true },
          }),
        ]);
        return {
          ...user,
          telegramId: user.telegramId.toString(), // Convert BigInt to string for JSON
          _count: { subscriptions: totalSubsCount }, // Only count active subscriptions
          activeSubscriptions: activeSubsCount,
        };
      })
    );

    res.json({
      users: usersWithStats,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Admin', 'Failed to get users', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// GET /admin/api/users/:id - User detail with all subscriptions
router.get('/api/users/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const user = await db.telegramUser.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        telegramId: true,
        username: true,
        firstName: true,
        createdAt: true,
        lastActiveAt: true,
        subscriptions: {
          select: {
            id: true,
            jobTitles: true,
            location: true,
            isRemote: true,
            isActive: true,
            isPaused: true,
            minScore: true,
            createdAt: true,
            nextRunAt: true,
            _count: {
              select: {
                sentNotifications: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Convert BigInt and add computed status
    const result = {
      ...user,
      telegramId: user.telegramId.toString(),
      subscriptions: user.subscriptions.map((sub) => ({
        ...sub,
        status: computeStatus(sub.isActive, sub.isPaused),
      })),
    };

    res.json(result);
  } catch (error) {
    logger.error('Admin', 'Failed to get user', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// GET /admin/api/subscriptions - All subscriptions with performance
router.get('/api/subscriptions', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;
    const statusFilter = req.query.status as string | undefined;

    // Build where clause based on status filter
    let where = {};
    if (statusFilter === 'active') {
      where = { isActive: true, isPaused: false };
    } else if (statusFilter === 'paused') {
      where = { isActive: true, isPaused: true };
    } else if (statusFilter === 'inactive') {
      where = { isActive: false };
    }

    const [subscriptions, total] = await Promise.all([
      db.searchSubscription.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: { nextRunAt: 'asc' },
        select: {
          id: true,
          jobTitles: true,
          location: true,
          isRemote: true,
          isActive: true,
          isPaused: true,
          debugMode: true,
          minScore: true,
          createdAt: true,
          nextRunAt: true,
          user: {
            select: {
              id: true,
              username: true,
              telegramId: true,
            },
          },
          _count: {
            select: {
              sentNotifications: true,
            },
          },
        },
      }),
      db.searchSubscription.count({ where }),
    ]);

    // Get recent run stats for each subscription
    const subsWithStats = await Promise.all(
      subscriptions.map(async (sub) => {
        const recentRuns = await db.subscriptionRun.findMany({
          where: { subscriptionId: sub.id },
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: {
            status: true,
            startedAt: true,
            jobsCollected: true,
            jobsMatched: true,
          },
        });

        const lastRun = recentRuns[0] || null;
        return {
          ...sub,
          status: computeStatus(sub.isActive, sub.isPaused),
          user: {
            ...sub.user,
            telegramId: sub.user.telegramId.toString(),
          },
          lastRun,
        };
      })
    );

    res.json({
      subscriptions: subsWithStats,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Admin', 'Failed to get subscriptions', error);
    res.status(500).json({ error: 'Failed to get subscriptions' });
  }
});

// GET /admin/api/subscriptions/:id - Subscription detail + run history
router.get('/api/subscriptions/:id', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const subscription = await db.searchSubscription.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        jobTitles: true,
        location: true,
        isRemote: true,
        isActive: true,
        isPaused: true,
        debugMode: true,
        minScore: true,
        createdAt: true,
        nextRunAt: true,
        resumeName: true,
        user: {
          select: {
            id: true,
            username: true,
            telegramId: true,
          },
        },
        _count: {
          select: {
            sentNotifications: true,
          },
        },
      },
    });

    if (!subscription) {
      res.status(404).json({ error: 'Subscription not found' });
      return;
    }

    // Get recent runs
    const runs = await db.subscriptionRun.findMany({
      where: { subscriptionId: req.params.id },
      orderBy: { startedAt: 'desc' },
      take: 20,
      select: {
        id: true,
        triggerType: true,
        status: true,
        startedAt: true,
        completedAt: true,
        durationMs: true,
        jobsCollected: true,
        jobsAfterDedup: true,
        jobsMatched: true,
        notificationsSent: true,
        errorMessage: true,
      },
    });

    // Get skill stats
    const skillStats = await db.skillStats.findMany({
      where: { subscriptionId: req.params.id },
      orderBy: { demandCount: 'desc' },
      take: 20,
    });

    res.json({
      ...subscription,
      status: computeStatus(subscription.isActive, subscription.isPaused),
      user: {
        ...subscription.user,
        telegramId: subscription.user.telegramId.toString(),
      },
      runs,
      skillStats,
    });
  } catch (error) {
    logger.error('Admin', 'Failed to get subscription', error);
    res.status(500).json({ error: 'Failed to get subscription' });
  }
});

// POST /admin/api/subscriptions/:id/debug - Toggle debug mode
router.post('/api/subscriptions/:id/debug', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { enabled } = req.body;

    // Validate input
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }

    // Update subscription
    const subscription = await db.searchSubscription.update({
      where: { id },
      data: { debugMode: enabled },
      select: {
        id: true,
        debugMode: true,
        user: {
          select: {
            username: true,
          },
        },
        jobTitles: true,
      },
    });

    logger.info(
      'Admin',
      `Debug mode ${enabled ? 'enabled' : 'disabled'} for subscription ${id} (@${subscription.user.username}: ${subscription.jobTitles.slice(0, 2).join(', ')})`
    );

    res.json({
      success: true,
      subscription: {
        id: subscription.id,
        debugMode: subscription.debugMode,
      },
    });
  } catch (error) {
    if ((error as any).code === 'P2025') {
      res.status(404).json({ error: 'Subscription not found' });
      return;
    }
    logger.error('Admin', 'Failed to toggle debug mode', error);
    res.status(500).json({ error: 'Failed to toggle debug mode' });
  }
});

// GET /admin/api/runs - Execution history
router.get('/api/runs', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit as string) || 100));
    const offset = (page - 1) * limit;
    const status = req.query.status as string | undefined;

    const where = status ? { status } : {};

    const [runs, total] = await Promise.all([
      db.subscriptionRun.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          triggerType: true,
          status: true,
          startedAt: true,
          completedAt: true,
          durationMs: true,
          jobsCollected: true,
          jobsAfterDedup: true,
          jobsMatched: true,
          notificationsSent: true,
          errorMessage: true,
          subscription: {
            select: {
              id: true,
              jobTitles: true,
              user: {
                select: {
                  username: true,
                },
              },
            },
          },
        },
      }),
      db.subscriptionRun.count({ where }),
    ]);

    res.json({
      runs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Admin', 'Failed to get runs', error);
    res.status(500).json({ error: 'Failed to get runs' });
  }
});

// GET /admin/api/errors - Recent failures
router.get('/api/errors', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));

    const errors = await db.subscriptionRun.findMany({
      where: { status: 'failed' },
      orderBy: { startedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        triggerType: true,
        startedAt: true,
        errorMessage: true,
        errorStack: true,
        subscription: {
          select: {
            id: true,
            jobTitles: true,
            user: {
              select: {
                username: true,
              },
            },
          },
        },
      },
    });

    res.json({ errors });
  } catch (error) {
    logger.error('Admin', 'Failed to get errors', error);
    res.status(500).json({ error: 'Failed to get errors' });
  }
});

// GET /admin/api/runs/active - Currently running subscriptions with progress
router.get('/api/runs/active', async (req: Request, res: Response) => {
  try {
    const db = getDb();

    const activeRuns = await db.subscriptionRun.findMany({
      where: { status: 'running' },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        startedAt: true,
        currentStage: true,
        progressPercent: true,
        progressDetail: true,
        jobsCollected: true,
        jobsMatched: true,
        subscription: {
          select: {
            id: true,
            jobTitles: true,
            location: true,
            user: {
              select: {
                username: true,
              },
            },
          },
        },
      },
    });

    res.json({
      runs: activeRuns.map((r) => ({
        runId: r.id,
        subscriptionId: r.subscription.id,
        username: r.subscription.user.username,
        jobTitles: r.subscription.jobTitles.slice(0, 2).join(', '),
        location: r.subscription.location || 'Remote',
        stage: r.currentStage || 'starting',
        progress: r.progressPercent ?? 0,
        detail: r.progressDetail || 'In progress...',
        jobsCollected: r.jobsCollected ?? 0,
        jobsMatched: r.jobsMatched ?? 0,
        duration: Math.round((Date.now() - r.startedAt.getTime()) / 1000),
        startedAt: r.startedAt.toISOString(),
      })),
      count: activeRuns.length,
    });
  } catch (error) {
    logger.error('Admin', 'Failed to get active runs', error);
    res.status(500).json({ error: 'Failed to get active runs' });
  }
});

// GET /admin/api/diagnostics - System diagnostics for debugging stuck runs
router.get('/api/diagnostics', async (req: Request, res: Response) => {
  try {
    const db = getDb();

    // Get all runs that are in "running" state
    const runningRuns = await db.subscriptionRun.findMany({
      where: { status: 'running' },
      orderBy: { startedAt: 'asc' },
      select: {
        id: true,
        subscriptionId: true,
        startedAt: true,
        currentStage: true,
        progressPercent: true,
        progressDetail: true,
        checkpoint: true,
        subscription: {
          select: {
            jobTitles: true,
            nextRunAt: true,
            user: { select: { username: true } },
          },
        },
      },
    });

    // Check lock status for each running run
    const runsWithDiagnostics = await Promise.all(
      runningRuns.map(async (run) => {
        const durationMs = Date.now() - run.startedAt.getTime();
        const isLocked = await isSubscriptionRunning(run.subscriptionId);

        return {
          runId: run.id,
          subscriptionId: run.subscriptionId.slice(0, 8),
          username: run.subscription.user?.username || 'unknown',
          jobTitles: run.subscription.jobTitles.slice(0, 2).join(', '),
          startedAt: run.startedAt.toISOString(),
          durationMinutes: Math.round(durationMs / 60000),
          stage: run.currentStage || 'unknown',
          progress: run.progressPercent || 0,
          progressDetail: run.progressDetail,
          hasCheckpoint: run.checkpoint !== null,
          lockStatus: isLocked ? 'LOCKED' : 'UNLOCKED',
          nextRunAt: run.subscription.nextRunAt?.toISOString(),
          issues: [
            ...(durationMs > 30 * 60 * 1000 ? ['Run duration > 30 min'] : []),
            ...(durationMs > 10 * 60 * 1000 && !run.checkpoint ? ['No checkpoint after 10 min'] : []),
            ...(!isLocked ? ['Lock missing - potential race condition'] : []),
            ...(run.currentStage === 'collection' && durationMs > 15 * 60 * 1000 ? ['Stuck in collection'] : []),
          ],
        };
      })
    );

    // Get queue stats
    const { collectionQueue, matchingQueue } = getQueues();
    let queueStats = null;

    if (collectionQueue && matchingQueue && isRedisConnected()) {
      const [
        collWaiting, collActive, collCompleted, collFailed,
        matchWaiting, matchActive, matchCompleted, matchFailed,
      ] = await Promise.all([
        collectionQueue.getWaitingCount(),
        collectionQueue.getActiveCount(),
        collectionQueue.getCompletedCount(),
        collectionQueue.getFailedCount(),
        matchingQueue.getWaitingCount(),
        matchingQueue.getActiveCount(),
        matchingQueue.getCompletedCount(),
        matchingQueue.getFailedCount(),
      ]);

      queueStats = {
        collection: { waiting: collWaiting, active: collActive, completed: collCompleted, failed: collFailed },
        matching: { waiting: matchWaiting, active: matchActive, completed: matchCompleted, failed: matchFailed },
      };
    }

    // Get Redis lock info
    const redis = getRedis();
    let lockInfo: Array<{ key: string; subscription: string; value: unknown }> = [];
    if (redis && isRedisConnected()) {
      try {
        const keys = await redis.keys('lock:subscription:*');
        for (const key of keys) {
          const value = await redis.get(key);
          lockInfo.push({
            key,
            subscription: key.replace('lock:subscription:', '').slice(0, 8),
            value: value ? JSON.parse(value) : null,
          });
        }
      } catch (e) {
        logger.warn('Admin', 'Failed to get Redis lock info', e);
      }
    }

    // Get recent failed runs
    const recentFailures = await db.subscriptionRun.findMany({
      where: {
        status: 'failed',
        startedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        startedAt: true,
        durationMs: true,
        failedStage: true,
        errorMessage: true,
        subscription: {
          select: {
            jobTitles: true,
            user: { select: { username: true } },
          },
        },
      },
    });

    // Get request cache stats
    const cacheStats = queueService.getRequestCacheStats();

    res.json({
      timestamp: new Date().toISOString(),
      summary: {
        runningCount: runningRuns.length,
        problematicRuns: runsWithDiagnostics.filter(r => r.issues.length > 0).length,
        redisConnected: isRedisConnected(),
        activeLocks: lockInfo.length,
        requestCacheSize: cacheStats.size,
      },
      runningRuns: runsWithDiagnostics,
      queueStats,
      locks: lockInfo,
      recentFailures: recentFailures.map(f => ({
        runId: f.id,
        username: f.subscription.user?.username || 'unknown',
        jobTitles: f.subscription.jobTitles.slice(0, 2).join(', '),
        startedAt: f.startedAt.toISOString(),
        durationSeconds: f.durationMs ? Math.round(f.durationMs / 1000) : null,
        failedStage: f.failedStage,
        errorMessage: f.errorMessage?.slice(0, 200),
      })),
      requestCache: cacheStats,
    });
  } catch (error) {
    logger.error('Admin', 'Failed to get diagnostics', error);
    res.status(500).json({ error: 'Failed to get diagnostics' });
  }
});

// POST /admin/api/diagnostics/fail-stuck - Manually fail stuck runs
router.post('/api/diagnostics/fail-stuck', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const { minAgeMinutes = 30 } = req.body;

    const cutoff = new Date(Date.now() - minAgeMinutes * 60 * 1000);

    // Find runs that are stuck
    const stuckRuns = await db.subscriptionRun.findMany({
      where: {
        status: 'running',
        startedAt: { lt: cutoff },
      },
      select: {
        id: true,
        subscriptionId: true,
        startedAt: true,
        currentStage: true,
      },
    });

    if (stuckRuns.length === 0) {
      res.json({ message: 'No stuck runs found', count: 0 });
      return;
    }

    // Mark them as failed and release locks
    const now = new Date();
    for (const run of stuckRuns) {
      const durationMs = now.getTime() - run.startedAt.getTime();
      await db.subscriptionRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          completedAt: now,
          durationMs,
          errorMessage: `Manually marked as failed after ${Math.round(durationMs / 60000)} minutes (admin action)`,
          failedStage: run.currentStage || 'unknown',
        },
      });

      // Release the lock for this subscription
      await releaseSubscriptionLock(run.subscriptionId);

      // Schedule immediate retry
      await db.searchSubscription.update({
        where: { id: run.subscriptionId },
        data: { nextRunAt: new Date(Date.now() + 60 * 1000) }, // Retry in 1 minute
      });
    }

    logger.info('Admin', `Manually failed ${stuckRuns.length} stuck runs`);

    res.json({
      message: `Failed ${stuckRuns.length} stuck runs`,
      count: stuckRuns.length,
      failedRuns: stuckRuns.map(r => ({
        runId: r.id,
        subscriptionId: r.subscriptionId.slice(0, 8),
        stage: r.currentStage,
        duration: Math.round((now.getTime() - r.startedAt.getTime()) / 60000) + ' min',
      })),
    });
  } catch (error) {
    logger.error('Admin', 'Failed to fail stuck runs', error);
    res.status(500).json({ error: 'Failed to fail stuck runs' });
  }
});

// SPA catch-all: serve index.html for any non-API route
// This enables client-side routing in the React app
router.get('*', (_req: Request, res: Response) => {
  const indexPath = path.join(adminUiPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      logger.error('Admin', 'Failed to serve admin UI', err);
      res.status(500).send('Admin UI not available');
    }
  });
});

export { router as adminRouter };
