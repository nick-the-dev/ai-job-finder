import { getDb } from '../db/client.js';

interface OverviewData {
  users: { total: number; activeToday: number; newThisWeek: number };
  subscriptions: { total: number; active: number; paused: number };
  activity24h: {
    jobsScanned: number;
    matchesFound: number;
    notificationsSent: number;
    totalRuns: number;
    failedRuns: number;
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
}

function computeStatus(isActive: boolean, isPaused: boolean): string {
  if (!isActive) return 'inactive';
  if (isPaused) return 'paused';
  return 'active';
}

async function getOverviewData(): Promise<OverviewData> {
  const db = getDb();
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    activeToday,
    newThisWeek,
    totalSubscriptions,
    activeSubscriptions,
    pausedSubscriptions,
    jobsScanned24h,
    matchesFound24h,
    notificationsSent24h,
    totalRuns,
    failedRuns24h,
  ] = await Promise.all([
    db.telegramUser.count(),
    db.telegramUser.count({ where: { lastActiveAt: { gte: oneDayAgo } } }),
    db.telegramUser.count({ where: { createdAt: { gte: oneWeekAgo } } }),
    db.searchSubscription.count(),
    db.searchSubscription.count({ where: { isActive: true, isPaused: false } }),
    db.searchSubscription.count({ where: { isActive: true, isPaused: true } }),
    db.subscriptionRun.aggregate({
      where: { startedAt: { gte: oneDayAgo } },
      _sum: { jobsCollected: true },
    }),
    db.subscriptionRun.aggregate({
      where: { startedAt: { gte: oneDayAgo } },
      _sum: { jobsMatched: true },
    }),
    db.subscriptionRun.aggregate({
      where: { startedAt: { gte: oneDayAgo } },
      _sum: { notificationsSent: true },
    }),
    db.subscriptionRun.count({ where: { startedAt: { gte: oneDayAgo } } }),
    db.subscriptionRun.count({
      where: { startedAt: { gte: oneDayAgo }, status: 'failed' },
    }),
  ]);

  return {
    users: { total: totalUsers, activeToday, newThisWeek },
    subscriptions: { total: totalSubscriptions, active: activeSubscriptions, paused: pausedSubscriptions },
    activity24h: {
      jobsScanned: jobsScanned24h._sum.jobsCollected ?? 0,
      matchesFound: matchesFound24h._sum.jobsMatched ?? 0,
      notificationsSent: notificationsSent24h._sum.notificationsSent ?? 0,
      totalRuns,
      failedRuns: failedRuns24h,
    },
  };
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
      _count: { select: { subscriptions: true } },
    },
  });

  return Promise.all(
    users.map(async (u) => {
      const activeCount = await db.searchSubscription.count({
        where: { userId: u.id, isActive: true, isPaused: false },
      });
      return {
        id: u.id,
        username: u.username,
        telegramId: u.telegramId,
        createdAt: u.createdAt,
        lastActiveAt: u.lastActiveAt,
        subscriptionCount: u._count.subscriptions,
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
    take: 20,
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      status: true,
      startedAt: true,
      durationMs: true,
      jobsMatched: true,
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
    jobsMatched: r.jobsMatched,
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

export async function generateDashboardHtml(): Promise<string> {
  const [overview, users, subscriptions, recentRuns] = await Promise.all([
    getOverviewData(),
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
  </style>
</head>
<body>
  <div class="container">
    <h1>AI Job Finder Admin</h1>

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
        <div class="card-title">Jobs Scanned (24h)</div>
        <div class="card-value">${overview.activity24h.jobsScanned.toLocaleString()}</div>
        <div class="card-sub">${overview.activity24h.matchesFound} matches found</div>
      </div>
      <div class="card">
        <div class="card-title">Notifications (24h)</div>
        <div class="card-value">${overview.activity24h.notificationsSent}</div>
        <div class="card-sub">from ${overview.activity24h.totalRuns} runs</div>
      </div>
      <div class="card ${overview.activity24h.failedRuns > 0 ? 'card-bad' : 'card-good'}">
        <div class="card-title">Failed Runs (24h)</div>
        <div class="card-value">${overview.activity24h.failedRuns}</div>
        <div class="card-sub">${overview.activity24h.totalRuns > 0 ? ((overview.activity24h.failedRuns / overview.activity24h.totalRuns) * 100).toFixed(1) : 0}% failure rate</div>
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
            <th>Matches</th>
            <th>Duration</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          ${recentRuns
            .map(
              (r) => `
            <tr>
              <td>${escapeHtml(r.username) || '<em>No username</em>'}</td>
              <td class="truncate" title="${escapeHtml(r.subJobTitles.join(', '))}">${escapeHtml(r.subJobTitles.slice(0, 2).join(', '))}${r.subJobTitles.length > 2 ? '...' : ''}</td>
              <td>${statusBadge(r.status)}</td>
              <td>${r.jobsMatched}</td>
              <td>${r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '-'}</td>
              <td>${formatTimeAgo(r.startedAt)}</td>
            </tr>
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
  </script>
</body>
</html>`;
}
