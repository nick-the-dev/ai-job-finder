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
  activity24h: {
    jobsScanned: number;
    matchesFound: number;
    notificationsSent: number;
    totalRuns: number;
    failedRuns: number;
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
