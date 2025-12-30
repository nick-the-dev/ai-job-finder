import type {
  OverviewData,
  UsersResponse,
  SubscriptionsResponse,
  RunsResponse,
  ErrorsResponse,
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

async function fetchApi<T>(endpoint: string): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'X-Admin-Key': getAdminKey(),
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

export async function getOverview(): Promise<OverviewData> {
  return fetchApi<OverviewData>('/overview');
}

export async function getUsers(page = 1, limit = 20): Promise<UsersResponse> {
  return fetchApi<UsersResponse>(`/users?page=${page}&limit=${limit}`);
}

export async function getSubscriptions(
  page = 1,
  limit = 20,
  status?: string
): Promise<SubscriptionsResponse> {
  let url = `/subscriptions?page=${page}&limit=${limit}`;
  if (status) {
    url += `&status=${status}`;
  }
  return fetchApi<SubscriptionsResponse>(url);
}

export async function getRuns(page = 1, limit = 50): Promise<RunsResponse> {
  return fetchApi<RunsResponse>(`/runs?page=${page}&limit=${limit}`);
}

export async function getErrors(limit = 50): Promise<ErrorsResponse> {
  return fetchApi<ErrorsResponse>(`/errors?limit=${limit}`);
}
