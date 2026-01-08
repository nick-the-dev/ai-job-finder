import { getDb } from '../db/client.js';

type Period = '24h' | '7d' | '30d' | 'all';

interface ActivityMetrics {
  jobsScanned: number;
  matchesFound: number;
  notificationsSent: number;
  totalRuns: number;
  failedRuns: number;
}

interface OverviewData {
  users: { total: number; activeToday: number; newThisWeek: number };
  subscriptions: { total: number; active: number; paused: number };
  activity: ActivityMetrics & { period: Period; periodLabel: string };
  comparison?: {
    period: string;
    activity: ActivityMetrics;
    changes: Record<string, number | null>;
  };
}

interface UserRow {
  id: string;
  username: string | null;
  telegramId: bigint;
  createdAt: Date;
  lastActiveAt: Date | null;
  subscriptionCount: number;
  activeSubscriptions: number;
}

interface SubscriptionRow {
  id: string;
  jobTitles: string[];
  location: string | null;
  status: string;
  username: string | null;
  notificationCount: number;
  lastRunStatus: string | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
}

interface RecentRun {
  id: string;
  username: string | null;
  subJobTitles: string[];
  status: string;
  startedAt: Date;
  durationMs: number | null;
  jobsMatched: number;
  jobsCollected: number;
  notificationsSent: number;
  // Error details for failed runs
  failedStage: string | null;
  errorMessage: string | null;
  errorContext: Record<string, unknown> | null;
}

function computeStatus(isActive: boolean, isPaused: boolean): string {
  if (!isActive) return 'inactive';
  if (isPaused) return 'paused';
  return 'active';
}

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
  if (period === 'all') return null;

  const now = new Date();
  const periodMs = period === '24h' ? 24 * 60 * 60 * 1000
                 : period === '7d' ? 7 * 24 * 60 * 60 * 1000
                 : 30 * 24 * 60 * 60 * 1000;

  return {
    start: new Date(now.getTime() - 2 * periodMs),
    end: new Date(now.getTime() - periodMs)
  };
}

async function getActivityMetrics(db: ReturnType<typeof getDb>, start: Date | null, end: Date): Promise<ActivityMetrics> {
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

async function getOverviewData(period: Period = '24h', includeComparison: boolean = true): Promise<OverviewData> {
  const db = getDb();
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const { start: periodStart, end: periodEnd } = getPeriodRange(period);

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

  const activityMetrics = await getActivityMetrics(db, periodStart, periodEnd);

  const result: OverviewData = {
    users: { total: totalUsers, activeToday, newThisWeek },
    subscriptions: { total: totalSubscriptions, active: activeSubscriptions, paused: pausedSubscriptions },
    activity: {
      ...activityMetrics,
      period,
      periodLabel: period === 'all' ? 'All Time' : `Last ${period}`,
    },
  };

  // Add comparison if requested and not "all time"
  if (includeComparison) {
    const prevRange = getPreviousPeriodRange(period);
    if (prevRange) {
      const prevMetrics = await getActivityMetrics(db, prevRange.start, prevRange.end);

      const calcChange = (current: number, previous: number): number | null => {
        if (previous === 0) return current > 0 ? 100 : null;
        return Math.round(((current - previous) / previous) * 100);
      };

      result.comparison = {
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

  return result;
}

async function getUsersData(): Promise<UserRow[]> {
  const db = getDb();
  const users = await db.telegramUser.findMany({
    take: 50,
    orderBy: { lastActiveAt: 'desc' },
    select: {
      id: true,
      telegramId: true,
      username: true,
      createdAt: true,
      lastActiveAt: true,
    },
  });

  // Get subscription stats for each user (only count isActive: true subscriptions)
  return Promise.all(
    users.map(async (u) => {
      const [activeCount, totalCount] = await Promise.all([
        db.searchSubscription.count({
          where: { userId: u.id, isActive: true, isPaused: false },
        }),
        db.searchSubscription.count({
          where: { userId: u.id, isActive: true },
        }),
      ]);
      return {
        id: u.id,
        username: u.username,
        telegramId: u.telegramId,
        createdAt: u.createdAt,
        lastActiveAt: u.lastActiveAt,
        subscriptionCount: totalCount, // Only count active subscriptions (not deleted)
        activeSubscriptions: activeCount,
      };
    })
  );
}

async function getSubscriptionsData(): Promise<SubscriptionRow[]> {
  const db = getDb();
  const subs = await db.searchSubscription.findMany({
    take: 50,
    orderBy: { nextRunAt: 'asc' },
    select: {
      id: true,
      jobTitles: true,
      location: true,
      isActive: true,
      isPaused: true,
      nextRunAt: true,
      user: { select: { username: true } },
      _count: { select: { sentNotifications: true } },
    },
  });

  return Promise.all(
    subs.map(async (s) => {
      const lastRun = await db.subscriptionRun.findFirst({
        where: { subscriptionId: s.id },
        orderBy: { startedAt: 'desc' },
        select: { status: true, startedAt: true },
      });
      return {
        id: s.id,
        jobTitles: s.jobTitles,
        location: s.location,
        status: computeStatus(s.isActive, s.isPaused),
        username: s.user.username,
        notificationCount: s._count.sentNotifications,
        lastRunStatus: lastRun?.status ?? null,
        lastRunAt: lastRun?.startedAt ?? null,
        nextRunAt: s.nextRunAt,
      };
    })
  );
}

async function getRecentRuns(): Promise<RecentRun[]> {
  const db = getDb();
  const runs = await db.subscriptionRun.findMany({
    take: 50,
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      status: true,
      startedAt: true,
      durationMs: true,
      jobsCollected: true,
      jobsMatched: true,
      notificationsSent: true,
      failedStage: true,
      errorMessage: true,
      errorContext: true,
      subscription: {
        select: {
          jobTitles: true,
          user: { select: { username: true } },
        },
      },
    },
  });

  return runs.map((r) => ({
    id: r.id,
    username: r.subscription.user.username,
    subJobTitles: r.subscription.jobTitles,
    status: r.status,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    jobsCollected: r.jobsCollected,
    jobsMatched: r.jobsMatched,
    notificationsSent: r.notificationsSent,
    failedStage: r.failedStage,
    errorMessage: r.errorMessage,
    errorContext: r.errorContext as Record<string, unknown> | null,
  }));
}

function escapeHtml(str: string | null | undefined): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatTimeAgo(date: Date | null): string {
  if (!date) return 'Never';
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    active: '#22c55e',
    paused: '#eab308',
    inactive: '#6b7280',
    completed: '#22c55e',
    failed: '#ef4444',
    running: '#3b82f6',
  };
  const color = colors[status] || '#6b7280';
  return `<span style="background:${color};color:white;padding:2px 8px;border-radius:4px;font-size:12px">${escapeHtml(status)}</span>`;
}

function parsePeriod(periodStr: string | undefined): Period {
  if (periodStr === '7d' || periodStr === '30d' || periodStr === 'all') {
    return periodStr;
  }
  return '24h';
}

function formatChange(change: number | null): string {
  if (change === null) return '';
  const sign = change >= 0 ? '+' : '';
  const color = change > 0 ? '#22c55e' : change < 0 ? '#ef4444' : '#64748b';
  return `<span style="color:${color};font-size:12px;margin-left:5px">${sign}${change}%</span>`;
}

export async function generateDashboardHtml(periodParam?: string): Promise<string> {
  const period = parsePeriod(periodParam);
  const [overview, users, subscriptions, recentRuns] = await Promise.all([
    getOverviewData(period, true),
    getUsersData(),
    getSubscriptionsData(),
    getRecentRuns(),
  ]);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Job Finder - Admin Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      line-height: 1.5;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 { font-size: 24px; margin-bottom: 20px; color: #f8fafc; }
    h2 { font-size: 18px; margin: 30px 0 15px; color: #94a3b8; }

    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 30px;
    }
    .card {
      background: #1e293b;
      border-radius: 8px;
      padding: 20px;
      border: 1px solid #334155;
    }
    .card-title { font-size: 12px; color: #64748b; text-transform: uppercase; margin-bottom: 5px; }
    .card-value { font-size: 28px; font-weight: 600; color: #f8fafc; }
    .card-sub { font-size: 12px; color: #64748b; margin-top: 5px; }

    .card-good .card-value { color: #22c55e; }
    .card-warn .card-value { color: #eab308; }
    .card-bad .card-value { color: #ef4444; }

    table {
      width: 100%;
      border-collapse: collapse;
      background: #1e293b;
      border-radius: 8px;
      overflow: hidden;
      font-size: 14px;
    }
    th, td {
      padding: 12px 15px;
      text-align: left;
      border-bottom: 1px solid #334155;
    }
    th {
      background: #0f172a;
      color: #94a3b8;
      font-weight: 500;
      font-size: 12px;
      text-transform: uppercase;
    }
    tr:hover { background: #334155; }
    tr:last-child td { border-bottom: none; }

    .truncate {
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
    }
    .tab {
      padding: 8px 16px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 6px;
      color: #94a3b8;
      cursor: pointer;
      font-size: 14px;
    }
    .tab:hover { background: #334155; }
    .tab.active { background: #3b82f6; color: white; border-color: #3b82f6; }

    .section { display: none; }
    .section.active { display: block; }

    .refresh-note {
      font-size: 12px;
      color: #64748b;
      margin-top: 10px;
    }

    .period-selector {
      display: flex;
      gap: 8px;
      margin-bottom: 20px;
    }
    .period-btn {
      padding: 6px 14px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 6px;
      color: #94a3b8;
      cursor: pointer;
      font-size: 13px;
      text-decoration: none;
    }
    .period-btn:hover { background: #334155; color: #e2e8f0; }
    .period-btn.active { background: #3b82f6; color: white; border-color: #3b82f6; }

    .comparison-row {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-top: 4px;
      font-size: 11px;
      color: #64748b;
    }
    .comparison-row .prev { opacity: 0.7; }

    .failed-row:hover { background: #2d1b1b !important; }
    .failed-row td:first-child::before {
      content: '▶ ';
      color: #64748b;
      font-size: 10px;
    }
    .failed-row.expanded td:first-child::before {
      content: '▼ ';
    }
    .error-details:hover { background: transparent !important; }
  </style>
</head>
<body>
  <div class="container">
    <h1>AI Job Finder Admin</h1>

    <div class="period-selector">
      <a href="?period=24h" class="period-btn ${overview.activity.period === '24h' ? 'active' : ''}">24 Hours</a>
      <a href="?period=7d" class="period-btn ${overview.activity.period === '7d' ? 'active' : ''}">7 Days</a>
      <a href="?period=30d" class="period-btn ${overview.activity.period === '30d' ? 'active' : ''}">30 Days</a>
      <a href="?period=all" class="period-btn ${overview.activity.period === 'all' ? 'active' : ''}">All Time</a>
    </div>

    <div class="cards">
      <div class="card">
        <div class="card-title">Total Users</div>
        <div class="card-value">${overview.users.total}</div>
        <div class="card-sub">${overview.users.activeToday} active today, +${overview.users.newThisWeek} this week</div>
      </div>
      <div class="card">
        <div class="card-title">Subscriptions</div>
        <div class="card-value">${overview.subscriptions.total}</div>
        <div class="card-sub">${overview.subscriptions.active} active, ${overview.subscriptions.paused} paused</div>
      </div>
      <div class="card">
        <div class="card-title">Jobs Scanned (${overview.activity.periodLabel})</div>
        <div class="card-value">${overview.activity.jobsScanned.toLocaleString()}${overview.comparison ? formatChange(overview.comparison.changes.jobsScanned as number | null) : ''}</div>
        <div class="card-sub">${overview.activity.matchesFound} matches${overview.comparison ? formatChange(overview.comparison.changes.matchesFound as number | null) : ''}</div>
        ${overview.comparison ? `<div class="comparison-row"><span class="prev">vs ${overview.comparison.activity.jobsScanned.toLocaleString()} prev</span></div>` : ''}
      </div>
      <div class="card">
        <div class="card-title">Notifications (${overview.activity.periodLabel})</div>
        <div class="card-value">${overview.activity.notificationsSent}${overview.comparison ? formatChange(overview.comparison.changes.notificationsSent as number | null) : ''}</div>
        <div class="card-sub">from ${overview.activity.totalRuns} runs${overview.comparison ? formatChange(overview.comparison.changes.totalRuns as number | null) : ''}</div>
        ${overview.comparison ? `<div class="comparison-row"><span class="prev">vs ${overview.comparison.activity.notificationsSent} prev</span></div>` : ''}
      </div>
      <div class="card ${overview.activity.failedRuns > 0 ? 'card-bad' : 'card-good'}">
        <div class="card-title">Failed Runs (${overview.activity.periodLabel})</div>
        <div class="card-value">${overview.activity.failedRuns}${overview.comparison ? formatChange(overview.comparison.changes.failedRuns as number | null) : ''}</div>
        <div class="card-sub">${overview.activity.totalRuns > 0 ? ((overview.activity.failedRuns / overview.activity.totalRuns) * 100).toFixed(1) : 0}% failure rate</div>
        ${overview.comparison ? `<div class="comparison-row"><span class="prev">vs ${overview.comparison.activity.failedRuns} prev</span></div>` : ''}
      </div>
    </div>

    <div class="tabs">
      <div class="tab active" onclick="showSection('users')">Users</div>
      <div class="tab" onclick="showSection('subscriptions')">Subscriptions</div>
      <div class="tab" onclick="showSection('runs')">Recent Runs</div>
    </div>

    <div id="users" class="section active">
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Telegram ID</th>
            <th>Subscriptions</th>
            <th>Joined</th>
            <th>Last Active</th>
          </tr>
        </thead>
        <tbody>
          ${users
            .map(
              (u) => `
            <tr>
              <td>${escapeHtml(u.username) || '<em>No username</em>'}</td>
              <td><code>${u.telegramId.toString()}</code></td>
              <td>${u.activeSubscriptions}/${u.subscriptionCount}</td>
              <td>${formatTimeAgo(u.createdAt)}</td>
              <td>${formatTimeAgo(u.lastActiveAt)}</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <div id="subscriptions" class="section">
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Job Titles</th>
            <th>Location</th>
            <th>Status</th>
            <th>Notifications</th>
            <th>Last Run</th>
            <th>Next Run</th>
          </tr>
        </thead>
        <tbody>
          ${subscriptions
            .map(
              (s) => `
            <tr>
              <td>${escapeHtml(s.username) || '<em>No username</em>'}</td>
              <td class="truncate" title="${escapeHtml(s.jobTitles.join(', '))}">${escapeHtml(s.jobTitles.slice(0, 2).join(', '))}${s.jobTitles.length > 2 ? '...' : ''}</td>
              <td class="truncate" title="${escapeHtml(s.location)}">${escapeHtml(s.location) || '<em>Any</em>'}</td>
              <td>${statusBadge(s.status)}</td>
              <td>${s.notificationCount}</td>
              <td>${s.lastRunStatus ? statusBadge(s.lastRunStatus) : '-'} ${formatTimeAgo(s.lastRunAt)}</td>
              <td>${s.nextRunAt ? formatTimeAgo(s.nextRunAt) : '-'}</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <div id="runs" class="section">
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Subscription</th>
            <th>Status</th>
            <th>Collected</th>
            <th>Matches</th>
            <th>Sent</th>
            <th>Duration</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          ${recentRuns
            .map(
              (r, i) => `
            <tr class="${r.status === 'failed' ? 'failed-row' : ''}" ${r.status === 'failed' ? `onclick="toggleError(${i})"` : ''} style="${r.status === 'failed' ? 'cursor:pointer' : ''}">
              <td>${escapeHtml(r.username) || '<em>No username</em>'}</td>
              <td class="truncate" title="${escapeHtml(r.subJobTitles.join(', '))}">${escapeHtml(r.subJobTitles.slice(0, 2).join(', '))}${r.subJobTitles.length > 2 ? '...' : ''}</td>
              <td>${statusBadge(r.status)}${r.failedStage ? ` <span style="color:#94a3b8;font-size:11px">@ ${escapeHtml(r.failedStage)}</span>` : ''}</td>
              <td>${r.jobsCollected}</td>
              <td>${r.jobsMatched}</td>
              <td>${r.notificationsSent}</td>
              <td>${r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '-'}</td>
              <td>${formatTimeAgo(r.startedAt)}</td>
            </tr>
            ${r.status === 'failed' ? `
            <tr id="error-${i}" class="error-details" style="display:none">
              <td colspan="8" style="background:#1a1a2e;padding:15px">
                <div style="color:#ef4444;font-weight:500;margin-bottom:8px">Error: ${escapeHtml(r.errorMessage)}</div>
                ${r.errorContext ? `
                <div style="font-size:12px;color:#94a3b8">
                  <div style="margin-bottom:10px">
                    <strong>Stage:</strong> ${escapeHtml(r.failedStage)} |
                    <strong>Query:</strong> ${escapeHtml((r.errorContext.query as string) || '-')} |
                    <strong>Location:</strong> ${escapeHtml((r.errorContext.location as string) || '-')}
                  </div>
                  ${r.errorContext.partialResults ? `
                  <div style="margin-bottom:10px">
                    <strong>Progress before failure:</strong>
                    ${(r.errorContext.partialResults as Record<string, number>).jobsCollected ?? 0} collected,
                    ${(r.errorContext.partialResults as Record<string, number>).jobsNormalized ?? 0} normalized,
                    ${(r.errorContext.partialResults as Record<string, number>).jobsMatched ?? 0} matched
                  </div>
                  ` : ''}
                  ${r.errorContext.jobTitle ? `<div><strong>Failed on job:</strong> ${escapeHtml((r.errorContext.jobTitle as string))} at ${escapeHtml((r.errorContext.company as string) || '-')}</div>` : ''}
                  <details style="margin-top:10px">
                    <summary style="cursor:pointer;color:#64748b">Full context (JSON)</summary>
                    <pre style="background:#0f172a;padding:10px;border-radius:4px;margin-top:5px;overflow-x:auto;font-size:11px;max-height:200px;overflow-y:auto">${escapeHtml(JSON.stringify(r.errorContext, null, 2))}</pre>
                  </details>
                </div>
                ` : '<div style="color:#64748b;font-size:12px">No additional context available</div>'}
              </td>
            </tr>
            ` : ''}
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <p class="refresh-note">Data refreshes on page reload. Generated at ${new Date().toISOString()}</p>
  </div>

  <script>
    function showSection(name) {
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.getElementById(name).classList.add('active');
      document.querySelector('[onclick="showSection(\\'' + name + '\\')"]').classList.add('active');
    }

    function toggleError(index) {
      const errorRow = document.getElementById('error-' + index);
      const parentRow = errorRow.previousElementSibling;
      if (errorRow.style.display === 'none') {
        errorRow.style.display = 'table-row';
        parentRow.classList.add('expanded');
      } else {
        errorRow.style.display = 'none';
        parentRow.classList.remove('expanded');
      }
    }
  </script>
</body>
</html>`;
}
