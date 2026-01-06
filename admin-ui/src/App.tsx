import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  getOverview,
  getUsers,
  getSubscriptions,
  getRuns,
  getErrors,
  setAdminKey,
  hasAdminKey,
  toggleDebugMode,
} from '@/api/client';
import type {
  OverviewData,
  User,
  Subscription,
  Run,
  ErrorEntry,
  Period,
} from '@/api/types';

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
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

function formatNextRun(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = date.getTime() - now.getTime();

  // If in the past, it's overdue or running now
  if (diff < 0) {
    const mins = Math.floor(-diff / 60000);
    if (mins < 2) return 'Now';
    if (mins < 60) return `${mins}m overdue`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h overdue`;
    return `${Math.floor(hours / 24)}d overdue`;
  }

  // Future time
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (mins < 1) return 'Now';
  if (mins < 60) return `in ${mins}m`;
  if (hours < 24) return `in ${hours}h`;
  return `in ${days}d`;
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, 'default' | 'success' | 'warning' | 'destructive' | 'secondary'> = {
    active: 'success',
    paused: 'warning',
    inactive: 'secondary',
    completed: 'success',
    failed: 'destructive',
    running: 'default',
  };
  return <Badge variant={variants[status] || 'secondary'}>{status}</Badge>;
}

function TruncatedCell({ value, maxWidth = 200, className = '' }: { value: string; maxWidth?: number; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`block truncate cursor-default ${className}`} style={{ maxWidth }}>
          {value}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p className="max-w-md whitespace-pre-wrap">{value}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    setAdminKey(key);

    try {
      await getOverview();
      onLogin();
    } catch {
      setError('Invalid admin key');
      setAdminKey('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Admin Login</CardTitle>
          <CardDescription>Enter your admin API key to access the dashboard</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Admin API Key"
              className="w-full px-3 py-2 bg-input border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {error && <p className="text-destructive text-sm">{error}</p>}
            <button
              type="submit"
              disabled={loading || !key}
              className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Verifying...' : 'Login'}
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function ChangeIndicator({ change }: { change: number | null }) {
  if (change === null) return null;
  const isPositive = change >= 0;
  const color = isPositive ? 'text-green-500' : 'text-red-500';
  const sign = isPositive ? '+' : '';
  return (
    <span className={`text-xs ml-2 ${color}`}>
      {sign}{change}%
    </span>
  );
}

function PeriodSelector({ period, onChange }: { period: Period; onChange: (p: Period) => void }) {
  const periods: { value: Period; label: string }[] = [
    { value: '24h', label: '24h' },
    { value: '7d', label: '7d' },
    { value: '30d', label: '30d' },
    { value: 'all', label: 'All' },
  ];

  return (
    <div className="flex gap-1 bg-secondary/50 p-1 rounded-lg">
      {periods.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            period === value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function OverviewCards({ data }: { data: OverviewData }) {
  const { activity, comparison } = data;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Total Users</CardDescription>
          <CardTitle className="text-3xl">{data.users.total}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {data.users.activeToday} active today, +{data.users.newThisWeek} this week
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Subscriptions</CardDescription>
          <CardTitle className="text-3xl">{data.subscriptions.total}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {data.subscriptions.active} active, {data.subscriptions.paused} paused
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Jobs Scanned ({activity.periodLabel})</CardDescription>
          <CardTitle className="text-3xl flex items-center">
            {activity.jobsScanned.toLocaleString()}
            {comparison && <ChangeIndicator change={comparison.changes.jobsScanned} />}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {activity.matchesFound} matches
            {comparison && <ChangeIndicator change={comparison.changes.matchesFound} />}
          </p>
          {comparison && (
            <p className="text-xs text-muted-foreground/70 mt-1">
              vs {comparison.activity.jobsScanned.toLocaleString()} prev
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Notifications ({activity.periodLabel})</CardDescription>
          <CardTitle className="text-3xl flex items-center">
            {activity.notificationsSent}
            {comparison && <ChangeIndicator change={comparison.changes.notificationsSent} />}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            from {activity.totalRuns} runs
            {comparison && <ChangeIndicator change={comparison.changes.totalRuns} />}
          </p>
          {comparison && (
            <p className="text-xs text-muted-foreground/70 mt-1">
              vs {comparison.activity.notificationsSent} prev
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Failed Runs ({activity.periodLabel})</CardDescription>
          <CardTitle className={`text-3xl flex items-center ${activity.failedRuns > 0 ? 'text-destructive' : 'text-success'}`}>
            {activity.failedRuns}
            {comparison && <ChangeIndicator change={comparison.changes.failedRuns} />}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {activity.totalRuns > 0
              ? ((activity.failedRuns / activity.totalRuns) * 100).toFixed(1)
              : 0}% failure rate
          </p>
          {comparison && (
            <p className="text-xs text-muted-foreground/70 mt-1">
              vs {comparison.activity.failedRuns} prev
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function UsersTable({ users }: { users: User[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Telegram ID</TableHead>
          <TableHead>Subscriptions</TableHead>
          <TableHead>Joined</TableHead>
          <TableHead>Last Active</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => (
          <TableRow key={user.id}>
            <TableCell className="font-medium">{user.username || user.firstName || 'No name'}</TableCell>
            <TableCell className="font-mono text-sm">{user.telegramId}</TableCell>
            <TableCell>
              <span className="text-success">{user.activeSubscriptions}</span>
              <span className="text-muted-foreground">/{user._count.subscriptions}</span>
            </TableCell>
            <TableCell className="text-muted-foreground">{formatTimeAgo(user.createdAt)}</TableCell>
            <TableCell className="text-muted-foreground">{formatTimeAgo(user.lastActiveAt)}</TableCell>
          </TableRow>
        ))}
        {users.length === 0 && (
          <TableRow>
            <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
              No users found
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function SubscriptionRow({ sub, onDebugToggle }: { sub: Subscription; onDebugToggle: (id: string, enabled: boolean) => void }) {
  const isActive = sub.status === 'active' || sub.status === 'paused';
  const [toggling, setToggling] = useState(false);

  const handleDebugToggle = async () => {
    setToggling(true);
    try {
      await onDebugToggle(sub.id, !sub.debugMode);
    } finally {
      setToggling(false);
    }
  };

  // Show first 8 chars of UUID for display, full ID on hover
  const shortId = sub.id.slice(0, 8);

  return (
    <TableRow className={!isActive ? 'opacity-60' : ''}>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <code className="text-xs font-mono text-muted-foreground cursor-pointer hover:text-foreground">{shortId}</code>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-mono text-xs">{sub.id}</p>
            <p className="text-xs text-muted-foreground mt-1">Click to copy</p>
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="font-medium">{sub.user.username || 'No name'}</TableCell>
      <TableCell>
        <TruncatedCell value={sub.jobTitles.join(', ')} maxWidth={200} />
      </TableCell>
      <TableCell>
        {sub.location ? (
          <TruncatedCell value={sub.location} maxWidth={150} />
        ) : (
          <span className="text-muted-foreground">Any</span>
        )}
      </TableCell>
      <TableCell><StatusBadge status={sub.status} /></TableCell>
      <TableCell>{sub._count.sentNotifications}</TableCell>
      <TableCell>
        {sub.lastRun ? (
          <span className="flex items-center gap-2">
            <StatusBadge status={sub.lastRun.status} />
            <span className="text-muted-foreground">{formatTimeAgo(sub.lastRun.startedAt)}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {isActive ? formatNextRun(sub.nextRunAt) : '-'}
      </TableCell>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleDebugToggle}
              disabled={toggling}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                sub.debugMode
                  ? 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 border border-amber-500/50'
                  : 'bg-secondary text-muted-foreground hover:bg-secondary/80 border border-border'
              } disabled:opacity-50`}
            >
              {toggling ? '...' : sub.debugMode ? '🔍 Debug ON' : 'Debug'}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{sub.debugMode ? 'Disable debug logging' : 'Enable detailed debug logging for this subscription'}</p>
          </TooltipContent>
        </Tooltip>
      </TableCell>
    </TableRow>
  );
}

function SubscriptionsTable({ subscriptions, onDebugToggle }: { subscriptions: Subscription[]; onDebugToggle: (id: string, enabled: boolean) => void }) {
  // Separate active/paused from inactive
  const activeSubs = subscriptions.filter(s => s.status === 'active' || s.status === 'paused');
  const inactiveSubs = subscriptions.filter(s => s.status === 'inactive');

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>ID</TableHead>
          <TableHead>User</TableHead>
          <TableHead>Job Titles</TableHead>
          <TableHead>Location</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Notifications</TableHead>
          <TableHead>Last Run</TableHead>
          <TableHead>Next Run</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {activeSubs.map((sub) => (
          <SubscriptionRow key={sub.id} sub={sub} onDebugToggle={onDebugToggle} />
        ))}
        {activeSubs.length > 0 && inactiveSubs.length > 0 && (
          <TableRow>
            <TableCell colSpan={9} className="bg-muted/30 py-2 text-center">
              <span className="text-xs text-muted-foreground uppercase tracking-wider">
                Inactive Subscriptions ({inactiveSubs.length})
              </span>
            </TableCell>
          </TableRow>
        )}
        {inactiveSubs.map((sub) => (
          <SubscriptionRow key={sub.id} sub={sub} onDebugToggle={onDebugToggle} />
        ))}
        {subscriptions.length === 0 && (
          <TableRow>
            <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
              No subscriptions found
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function RunsTable({ runs }: { runs: Run[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Subscription</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Collected</TableHead>
          <TableHead>Matches</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Time</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell className="font-medium">{run.subscription.user.username || 'No name'}</TableCell>
            <TableCell>
              <TruncatedCell value={run.subscription.jobTitles.join(', ')} maxWidth={200} />
            </TableCell>
            <TableCell><StatusBadge status={run.status} /></TableCell>
            <TableCell>{run.jobsCollected}</TableCell>
            <TableCell>{run.jobsMatched}</TableCell>
            <TableCell className="text-muted-foreground">
              {run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '-'}
            </TableCell>
            <TableCell className="text-muted-foreground">{formatTimeAgo(run.startedAt)}</TableCell>
          </TableRow>
        ))}
        {runs.length === 0 && (
          <TableRow>
            <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
              No runs yet
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function ErrorsTable({ errors }: { errors: ErrorEntry[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Subscription</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Error</TableHead>
          <TableHead>Time</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {errors.map((error) => (
          <TableRow key={error.id}>
            <TableCell className="font-medium">{error.subscription.user.username || 'No name'}</TableCell>
            <TableCell>
              <TruncatedCell value={error.subscription.jobTitles.join(', ')} maxWidth={150} />
            </TableCell>
            <TableCell><Badge variant="secondary">{error.triggerType}</Badge></TableCell>
            <TableCell>
              <TruncatedCell value={error.errorMessage || 'Unknown error'} maxWidth={300} className="text-destructive" />
            </TableCell>
            <TableCell className="text-muted-foreground">{formatTimeAgo(error.startedAt)}</TableCell>
          </TableRow>
        ))}
        {errors.length === 0 && (
          <TableRow>
            <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
              No errors - all systems healthy!
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function Dashboard() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runsPage, setRunsPage] = useState(1);
  const [runsTotalPages, setRunsTotalPages] = useState(1);
  const [runsTotal, setRunsTotal] = useState(0);
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<Period>('24h');

  const loadRuns = async (page: number) => {
    const runsData = await getRuns(page, 100);
    setRuns(runsData.runs);
    setRunsPage(runsData.pagination.page);
    setRunsTotalPages(runsData.pagination.pages);
    setRunsTotal(runsData.pagination.total);
  };

  const loadOverview = async (p: Period) => {
    const overviewData = await getOverview(p, true);
    setOverview(overviewData);
  };

  const handlePeriodChange = (newPeriod: Period) => {
    setPeriod(newPeriod);
    loadOverview(newPeriod);
  };

  useEffect(() => {
    async function loadData() {
      try {
        setLoading(true);
        const [overviewData, usersData, subsData, runsData, errorsData] = await Promise.all([
          getOverview(period, true),
          getUsers(),
          getSubscriptions(),
          getRuns(runsPage, 100),
          getErrors(),
        ]);
        setOverview(overviewData);
        setUsers(usersData.users);
        setSubscriptions(subsData.subscriptions);
        setRuns(runsData.runs);
        setRunsPage(runsData.pagination.page);
        setRunsTotalPages(runsData.pagination.pages);
        setRunsTotal(runsData.pagination.total);
        setErrors(errorsData.errors);
        setError('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        setLoading(false);
      }
    }

    loadData();
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleLogout = () => {
    setAdminKey('');
    window.location.reload();
  };

  const handleDebugToggle = async (subscriptionId: string, enabled: boolean) => {
    try {
      const result = await toggleDebugMode(subscriptionId, enabled);
      // Update local state optimistically
      setSubscriptions(subs =>
        subs.map(sub =>
          sub.id === subscriptionId
            ? { ...sub, debugMode: result.subscription.debugMode }
            : sub
        )
      );
    } catch (err) {
      console.error('Failed to toggle debug mode:', err);
      // Could add a toast notification here
    }
  };

  if (loading && !overview) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground">Loading dashboard...</div>
      </div>
    );
  }

  if (error && !overview) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <p className="text-destructive text-center">{error}</p>
            <button
              onClick={handleLogout}
              className="mt-4 w-full px-4 py-2 bg-secondary text-secondary-foreground rounded-lg font-medium hover:bg-secondary/90"
            >
              Logout
            </button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">AI Job Finder Admin</h1>
          <div className="flex items-center gap-4">
            <PeriodSelector period={period} onChange={handlePeriodChange} />
            <button
              onClick={handleLogout}
              className="px-4 py-2 text-sm bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/90"
            >
              Logout
            </button>
          </div>
        </div>

        {overview && <OverviewCards data={overview} />}

        <div className="mt-6">
          <Tabs defaultValue="users">
            <TabsList>
              <TabsTrigger value="users">Users ({users.length})</TabsTrigger>
              <TabsTrigger value="subscriptions">Subscriptions ({subscriptions.length})</TabsTrigger>
              <TabsTrigger value="runs">Runs ({runsTotal})</TabsTrigger>
              <TabsTrigger value="errors">
                Errors ({errors.length})
                {errors.length > 0 && <span className="ml-1 w-2 h-2 rounded-full bg-destructive inline-block" />}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="users" className="mt-4">
              <Card>
                <CardContent className="pt-6">
                  <UsersTable users={users} />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="subscriptions" className="mt-4">
              <Card>
                <CardContent className="pt-6">
                  <SubscriptionsTable subscriptions={subscriptions} onDebugToggle={handleDebugToggle} />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="runs" className="mt-4">
              <Card>
                <CardContent className="pt-6">
                  <RunsTable runs={runs} />
                  {runsTotalPages > 1 && (
                    <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                      <p className="text-sm text-muted-foreground">
                        Showing {runs.length} of {runsTotal} total runs
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => loadRuns(runsPage - 1)}
                          disabled={runsPage <= 1}
                          className="px-3 py-1 text-sm bg-secondary text-secondary-foreground rounded hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Previous
                        </button>
                        <span className="text-sm text-muted-foreground">
                          Page {runsPage} of {runsTotalPages}
                        </span>
                        <button
                          onClick={() => loadRuns(runsPage + 1)}
                          disabled={runsPage >= runsTotalPages}
                          className="px-3 py-1 text-sm bg-secondary text-secondary-foreground rounded hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}
                  {runsTotalPages <= 1 && runsTotal > 0 && (
                    <p className="text-sm text-muted-foreground mt-4 pt-4 border-t border-border">
                      Showing all {runsTotal} runs
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="errors" className="mt-4">
              <Card>
                <CardContent className="pt-6">
                  <ErrorsTable errors={errors} />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <p className="text-sm text-muted-foreground mt-6 text-center">
          Auto-refreshes every 30 seconds. Last updated: {overview?.timestamp ? new Date(overview.timestamp).toLocaleString() : '-'}
        </p>
      </div>
    </div>
  );
}

function App() {
  const [authenticated, setAuthenticated] = useState(hasAdminKey());

  if (!authenticated) {
    return <LoginScreen onLogin={() => setAuthenticated(true)} />;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Dashboard />
    </TooltipProvider>
  );
}

export default App;
