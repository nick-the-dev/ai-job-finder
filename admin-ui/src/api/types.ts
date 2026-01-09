export type Period = '24h' | '7d' | '30d' | 'all';

export interface ActivityMetrics {
  jobsScanned: number;
  matchesFound: number;
  notificationsSent: number;
  totalRuns: number;
  failedRuns: number;
}

export interface OverviewData {
  users: {
    total: number;
    activeToday: number;
    newThisWeek: number;
  };
  subscriptions: {
    total: number;
    active: number;
    paused: number;
  };
  activity: ActivityMetrics & {
    period: Period;
    periodLabel: string;
  };
  comparison?: {
    period: string;
    activity: ActivityMetrics;
    changes: {
      jobsScanned: number | null;
      matchesFound: number | null;
      notificationsSent: number | null;
      totalRuns: number | null;
      failedRuns: number | null;
    };
  };
  timestamp: string;
}

export interface User {
  id: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  createdAt: string;
  lastActiveAt: string | null;
  _count: {
    subscriptions: number;
  };
  activeSubscriptions: number;
}

export interface UsersResponse {
  users: User[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface Subscription {
  id: string;
  jobTitles: string[];
  location: string | null;
  isRemote: boolean;
  isActive: boolean;
  isPaused: boolean;
  debugMode: boolean;
  minScore: number;
  createdAt: string;
  nextRunAt: string | null;
  status: string;
  user: {
    id: string;
    username: string | null;
    telegramId: string;
  };
  _count: {
    sentNotifications: number;
  };
  lastRun: {
    status: string;
    startedAt: string;
    jobsCollected: number;
    jobsMatched: number;
  } | null;
}

export interface SubscriptionsResponse {
  subscriptions: Subscription[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface Run {
  id: string;
  triggerType: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  jobsCollected: number;
  jobsAfterDedup: number;
  jobsMatched: number;
  notificationsSent: number;
  errorMessage: string | null;
  // Progress fields for running subscriptions
  currentStage: string | null;
  progressPercent: number | null;
  progressDetail: string | null;
  // Error context for failed runs
  failedStage: string | null;
  errorContext: Record<string, unknown> | null;
  subscription: {
    id: string;
    jobTitles: string[];
    user: {
      username: string | null;
    };
  };
}

export interface RunsResponse {
  runs: Run[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface ErrorEntry {
  id: string;
  triggerType: string;
  startedAt: string;
  errorMessage: string | null;
  errorStack: string | null;
  subscription: {
    id: string;
    jobTitles: string[];
    user: {
      username: string | null;
    };
  };
}

export interface ErrorsResponse {
  errors: ErrorEntry[];
}

// Diagnostics types
export interface DiagnosticsRun {
  runId: string;
  subscriptionId: string;
  username: string;
  jobTitles: string;
  startedAt: string;
  durationMinutes: number;
  stage: string;
  progress: number;
  progressDetail: string | null;
  hasCheckpoint: boolean;
  lockStatus: 'LOCKED' | 'UNLOCKED';
  nextRunAt: string | null;
  warnings: string[];
}

export interface QueueStats {
  collection: { waiting: number; active: number; completed: number; failed: number };
  matching: { waiting: number; active: number; completed: number; failed: number };
}

export interface RecentFailure {
  runId: string;
  username: string;
  jobTitles: string;
  startedAt: string;
  durationSeconds: number | null;
  failedStage: string | null;
  errorMessage: string | null;
}

export interface DiagnosticsData {
  timestamp: string;
  summary: {
    runningCount: number;
    runsWithWarnings: number;
    redisConnected: boolean;
    activeLocks: number;
    requestCacheSize: number;
  };
  runningRuns: DiagnosticsRun[];
  queueStats: QueueStats | null;
  locks: Array<{ key: string; subscription: string; value: unknown }>;
  recentFailures: RecentFailure[];
  requestCache: { size: number; entries: unknown[] };
}

export interface FailStuckResponse {
  message: string;
  count: number;
  failedRuns?: Array<{
    runId: string;
    subscriptionId: string;
    stage: string | null;
    duration: string;
  }>;
}
