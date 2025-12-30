import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import {
  getOverview,
  getUsers,
  getSubscriptions,
  getRuns,
  getErrors,
  setAdminKey,
  hasAdminKey,
} from '@/api/client';
import type {
  OverviewData,
  User,
  Subscription,
  Run,
  ErrorEntry,
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

function OverviewCards({ data }: { data: OverviewData }) {
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
          <CardDescription>Jobs Scanned (24h)</CardDescription>
          <CardTitle className="text-3xl">{data.activity24h.jobsScanned.toLocaleString()}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {data.activity24h.matchesFound} matches found
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Notifications (24h)</CardDescription>
          <CardTitle className="text-3xl">{data.activity24h.notificationsSent}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            from {data.activity24h.totalRuns} runs
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Failed Runs (24h)</CardDescription>
          <CardTitle className={`text-3xl ${data.activity24h.failedRuns > 0 ? 'text-destructive' : 'text-success'}`}>
            {data.activity24h.failedRuns}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {data.activity24h.totalRuns > 0
              ? ((data.activity24h.failedRuns / data.activity24h.totalRuns) * 100).toFixed(1)
              : 0}% failure rate
          </p>
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

function SubscriptionsTable({ subscriptions }: { subscriptions: Subscription[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Job Titles</TableHead>
          <TableHead>Location</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Notifications</TableHead>
          <TableHead>Last Run</TableHead>
          <TableHead>Next Run</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {subscriptions.map((sub) => (
          <TableRow key={sub.id}>
            <TableCell className="font-medium">{sub.user.username || 'No name'}</TableCell>
            <TableCell className="max-w-[200px] truncate" title={sub.jobTitles.join(', ')}>
              {sub.jobTitles.slice(0, 2).join(', ')}
              {sub.jobTitles.length > 2 && '...'}
            </TableCell>
            <TableCell className="max-w-[150px] truncate" title={sub.location || 'Any'}>
              {sub.location || <span className="text-muted-foreground">Any</span>}
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
            <TableCell className="text-muted-foreground">{formatTimeAgo(sub.nextRunAt)}</TableCell>
          </TableRow>
        ))}
        {subscriptions.length === 0 && (
          <TableRow>
            <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
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
            <TableCell className="max-w-[200px] truncate" title={run.subscription.jobTitles.join(', ')}>
              {run.subscription.jobTitles.slice(0, 2).join(', ')}
              {run.subscription.jobTitles.length > 2 && '...'}
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
            <TableCell className="max-w-[150px] truncate" title={error.subscription.jobTitles.join(', ')}>
              {error.subscription.jobTitles.slice(0, 2).join(', ')}
            </TableCell>
            <TableCell><Badge variant="secondary">{error.triggerType}</Badge></TableCell>
            <TableCell className="max-w-[300px] truncate text-destructive" title={error.errorMessage || ''}>
              {error.errorMessage || 'Unknown error'}
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
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function loadData() {
      try {
        setLoading(true);
        const [overviewData, usersData, subsData, runsData, errorsData] = await Promise.all([
          getOverview(),
          getUsers(),
          getSubscriptions(),
          getRuns(),
          getErrors(),
        ]);
        setOverview(overviewData);
        setUsers(usersData.users);
        setSubscriptions(subsData.subscriptions);
        setRuns(runsData.runs);
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
          <button
            onClick={handleLogout}
            className="px-4 py-2 text-sm bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/90"
          >
            Logout
          </button>
        </div>

        {overview && <OverviewCards data={overview} />}

        <div className="mt-6">
          <Tabs defaultValue="users">
            <TabsList>
              <TabsTrigger value="users">Users ({users.length})</TabsTrigger>
              <TabsTrigger value="subscriptions">Subscriptions ({subscriptions.length})</TabsTrigger>
              <TabsTrigger value="runs">Runs ({runs.length})</TabsTrigger>
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
                  <SubscriptionsTable subscriptions={subscriptions} />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="runs" className="mt-4">
              <Card>
                <CardContent className="pt-6">
                  <RunsTable runs={runs} />
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

  return <Dashboard />;
}

export default App;
