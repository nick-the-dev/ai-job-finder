import type {
  OverviewData,
  UsersResponse,
  SubscriptionsResponse,
  RunsResponse,
  ErrorsResponse,
  DiagnosticsData,
  FailStuckResponse,
  Period,
} from './types';

const API_BASE = '/admin/api';

function getAdminKey(): string {
  return localStorage.getItem('adminKey') || '';
}

export function setAdminKey(key: string): void {
  localStorage.setItem('adminKey', key);
}

export function hasAdminKey(): boolean {
  return !!getAdminKey();
}

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'X-Admin-Key': getAdminKey(),
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Unauthorized - Invalid admin key');
    }
    if (response.status === 503) {
      throw new Error('Admin dashboard not configured');
    }
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

export async function getOverview(period: Period = '24h', compare = true): Promise<OverviewData> {
  const params = new URLSearchParams();
  params.set('period', period);
  if (compare) params.set('compare', 'true');
  return fetchApi<OverviewData>(`/overview?${params.toString()}`);
}

export async function getUsers(page = 1, limit = 20): Promise<UsersResponse> {
  return fetchApi<UsersResponse>(`/users?page=${page}&limit=${limit}`);
}

export async function getSubscriptions(
  page = 1,
  limit = 10000,
  status?: string
): Promise<SubscriptionsResponse> {
  let url = `/subscriptions?page=${page}&limit=${limit}`;
  if (status) {
    url += `&status=${status}`;
  }
  return fetchApi<SubscriptionsResponse>(url);
}

export async function getRuns(page = 1, limit = 100): Promise<RunsResponse> {
  return fetchApi<RunsResponse>(`/runs?page=${page}&limit=${limit}`);
}

export async function getErrors(limit = 50): Promise<ErrorsResponse> {
  return fetchApi<ErrorsResponse>(`/errors?limit=${limit}`);
}

export interface ToggleDebugModeResponse {
  success: boolean;
  subscription: {
    id: string;
    debugMode: boolean;
  };
}

export async function toggleDebugMode(
  subscriptionId: string,
  enabled: boolean
): Promise<ToggleDebugModeResponse> {
  return fetchApi<ToggleDebugModeResponse>(`/subscriptions/${subscriptionId}/debug`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

export async function getDiagnostics(): Promise<DiagnosticsData> {
  return fetchApi<DiagnosticsData>('/diagnostics');
}

export async function failStuckRuns(minAgeMinutes = 120): Promise<FailStuckResponse> {
  return fetchApi<FailStuckResponse>('/diagnostics/fail-stuck', {
    method: 'POST',
    body: JSON.stringify({ minAgeMinutes }),
  });
}

export interface StartRunResponse {
  success: boolean;
  message: string;
  subscription: {
    id: string;
    username: string | null;
  };
}

export async function startSubscriptionRun(subscriptionId: string): Promise<StartRunResponse> {
  return fetchApi<StartRunResponse>(`/subscriptions/${subscriptionId}/run/start`, {
    method: 'POST',
  });
}

export interface StopRunResponse {
  success: boolean;
  message: string;
  run: {
    id: string;
    subscriptionId: string;
    durationMs: number;
    stoppedAt: string | null;
    progressPercent: number | null;
  };
}

export async function stopRun(runId: string): Promise<StopRunResponse> {
  return fetchApi<StopRunResponse>(`/runs/${runId}/stop`, {
    method: 'POST',
  });
}
