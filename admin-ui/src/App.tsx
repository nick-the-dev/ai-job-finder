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
  getDiagnostics,
  failStuckRuns,
  setAdminKey,
  hasAdminKey,
  toggleDebugMode,
  startSubscriptionRun,
  stopRun,
  getBroadcasts,
  sendBroadcast,
  getBroadcastUsers,
} from '@/api/client';
import type {
  OverviewData,
  User,
  Subscription,
  Run,
  ErrorEntry,
  DiagnosticsData,
  Period,
  BroadcastNotification,
  BroadcastUser,
  SendBroadcastRequest,
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

function SubscriptionRow({
  sub,
  onDebugToggle,
  onStartRun,
}: {
  sub: Subscription;
  onDebugToggle: (id: string, enabled: boolean) => void;
  onStartRun: (id: string) => Promise<{ success: boolean; error?: string }>;
}) {
  const isActive = sub.status === 'active' || sub.status === 'paused';
  const [toggling, setToggling] = useState(false);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const handleDebugToggle = async () => {
    setToggling(true);
    try {
      await onDebugToggle(sub.id, !sub.debugMode);
    } finally {
      setToggling(false);
    }
  };

  const handleStartRun = async () => {
    setStarting(true);
    setRunError(null);
    try {
      const result = await onStartRun(sub.id);
      if (!result.success && result.error) {
        setRunError(result.error);
        setTimeout(() => setRunError(null), 5000); // Clear error after 5s
      }
    } finally {
      setStarting(false);
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
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleStartRun}
                disabled={starting || !isActive}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  starting
                    ? 'bg-primary/20 text-primary border border-primary/50'
                    : 'bg-green-500/20 text-green-400 hover:bg-green-500/30 border border-green-500/50'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {starting ? '...' : 'Run Now'}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {!isActive ? (
                <p>Subscription is inactive</p>
              ) : runError ? (
                <p className="text-destructive">{runError}</p>
              ) : (
                <p>Trigger an immediate run for this subscription</p>
              )}
            </TooltipContent>
          </Tooltip>
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
                {toggling ? '...' : sub.debugMode ? 'Debug ON' : 'Debug'}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{sub.debugMode ? 'Disable debug logging' : 'Enable detailed debug logging for this subscription'}</p>
            </TooltipContent>
          </Tooltip>
        </div>
        {runError && (
          <p className="text-xs text-destructive mt-1 max-w-[150px] truncate" title={runError}>
            {runError}
          </p>
        )}
      </TableCell>
    </TableRow>
  );
}

function SubscriptionsTable({
  subscriptions,
  onDebugToggle,
  onStartRun,
}: {
  subscriptions: Subscription[];
  onDebugToggle: (id: string, enabled: boolean) => void;
  onStartRun: (id: string) => Promise<{ success: boolean; error?: string }>;
}) {
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
          <SubscriptionRow key={sub.id} sub={sub} onDebugToggle={onDebugToggle} onStartRun={onStartRun} />
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
          <SubscriptionRow key={sub.id} sub={sub} onDebugToggle={onDebugToggle} onStartRun={onStartRun} />
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

function ProgressBar({ percent, stage, detail }: { percent: number; stage: string | null; detail: string | null }) {
  return (
    <div className="min-w-[120px]">
      <div className="relative h-5 bg-secondary rounded overflow-hidden">
        <div
          className="absolute h-full bg-gradient-to-r from-primary to-green-500 transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
        <span className="absolute inset-0 flex items-center justify-center text-xs font-medium text-white drop-shadow-sm">
          {percent}% - {stage || 'starting'}
        </span>
      </div>
      {detail && (
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="text-xs text-muted-foreground mt-1 truncate max-w-[200px] cursor-default">
              {detail}
            </p>
          </TooltipTrigger>
          <TooltipContent>
            <p className="max-w-md whitespace-pre-wrap">{detail}</p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function ErrorDetails({ run }: { run: Run }) {
  const context = run.errorContext as Record<string, unknown> | null;

  // Extract values with proper type casting
  const query = context?.query as string | undefined;
  const location = context?.location as string | undefined;
  const jobTitle = context?.jobTitle as string | undefined;
  const company = context?.company as string | undefined;
  const partialResults = context?.partialResults as Record<string, number> | undefined;

  return (
    <div className="bg-muted/30 p-4 rounded-lg mt-2 text-sm">
      <div className="text-destructive font-medium mb-2">
        Error: {run.errorMessage || 'Unknown error'}
      </div>
      <div className="text-muted-foreground space-y-1">
        <div>
          <strong>Stage:</strong> {run.failedStage || 'unknown'}
          {query && <> | <strong>Query:</strong> {query}</>}
          {location && <> | <strong>Location:</strong> {location}</>}
        </div>
        {partialResults && (
          <div>
            <strong>Progress before failure:</strong>{' '}
            {partialResults.jobsCollected ?? 0} collected,{' '}
            {partialResults.jobsNormalized ?? 0} normalized,{' '}
            {partialResults.jobsMatched ?? 0} matched
          </div>
        )}
        {jobTitle && (
          <div>
            <strong>Failed on job:</strong> {jobTitle} at {company || '-'}
          </div>
        )}
      </div>
      {context && (
        <details className="mt-2">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            Full context (JSON)
          </summary>
          <pre className="mt-2 p-2 bg-background rounded text-xs overflow-x-auto max-h-40">
            {JSON.stringify(context, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function RunRow({
  run,
  onStopRun,
}: {
  run: Run;
  onStopRun?: (runId: string) => Promise<{ success: boolean; error?: string }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const isRunning = run.status === 'running';
  const isFailed = run.status === 'failed';
  const startTime = new Date(run.startedAt).getTime();
  const currentDuration = isRunning ? Math.round((Date.now() - startTime) / 1000) : null;

  const handleStopRun = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent row expansion
    if (!onStopRun) return;

    setStopping(true);
    setStopError(null);
    try {
      const result = await onStopRun(run.id);
      if (!result.success && result.error) {
        setStopError(result.error);
        setTimeout(() => setStopError(null), 5000);
      }
    } finally {
      setStopping(false);
    }
  };

  return (
    <>
      <TableRow
        className={`${isRunning ? 'bg-primary/5' : isFailed ? 'bg-destructive/5 cursor-pointer' : ''}`}
        onClick={isFailed ? () => setExpanded(!expanded) : undefined}
      >
        <TableCell className="font-medium">{run.subscription.user.username || 'No name'}</TableCell>
        <TableCell>
          <TruncatedCell value={run.subscription.jobTitles.join(', ')} maxWidth={200} />
        </TableCell>
        <TableCell>
          {isRunning ? (
            <ProgressBar
              percent={run.progressPercent ?? 0}
              stage={run.currentStage}
              detail={run.progressDetail}
            />
          ) : (
            <span className="flex items-center gap-2">
              <StatusBadge status={run.status} />
              {run.failedStage && (
                <span className="text-xs text-muted-foreground">@ {run.failedStage}</span>
              )}
              {isFailed && <span className="text-xs text-muted-foreground">{expanded ? '▼' : '▶'}</span>}
            </span>
          )}
        </TableCell>
        <TableCell>{run.jobsCollected}</TableCell>
        <TableCell>{run.jobsMatched}</TableCell>
        <TableCell>{run.notificationsSent}</TableCell>
        <TableCell className="text-muted-foreground">
          {isRunning ? `${currentDuration}s` : run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '-'}
        </TableCell>
        <TableCell className="text-muted-foreground">{formatTimeAgo(run.startedAt)}</TableCell>
        <TableCell>
          {isRunning && onStopRun && (
            <div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleStopRun}
                    disabled={stopping}
                    className="px-2 py-1 text-xs rounded transition-colors bg-destructive/20 text-destructive hover:bg-destructive/30 border border-destructive/50 disabled:opacity-50"
                  >
                    {stopping ? '...' : 'Stop'}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {stopError ? (
                    <p className="text-destructive">{stopError}</p>
                  ) : (
                    <p>Stop this run immediately</p>
                  )}
                </TooltipContent>
              </Tooltip>
              {stopError && (
                <p className="text-xs text-destructive mt-1 max-w-[100px] truncate" title={stopError}>
                  {stopError}
                </p>
              )}
            </div>
          )}
        </TableCell>
      </TableRow>
      {isFailed && expanded && (
        <TableRow>
          <TableCell colSpan={9} className="p-0">
            <ErrorDetails run={run} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function RunsTable({
  runs,
  onStopRun,
}: {
  runs: Run[];
  onStopRun?: (runId: string) => Promise<{ success: boolean; error?: string }>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Subscription</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Collected</TableHead>
          <TableHead>Matches</TableHead>
          <TableHead>Sent</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Time</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <RunRow key={run.id} run={run} onStopRun={onStopRun} />
        ))}
        {runs.length === 0 && (
          <TableRow>
            <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
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

function TelegramPreview({ message, parseMode }: { message: string; parseMode: 'HTML' | 'MarkdownV2' | 'plain' }) {
  if (!message.trim()) {
    return (
      <div className="text-muted-foreground italic text-sm">
        Preview will appear here...
      </div>
    );
  }

  // For plain text, just show as-is with newlines preserved
  if (parseMode === 'plain') {
    return <div className="whitespace-pre-wrap">{message}</div>;
  }

  // For HTML, render with dangerouslySetInnerHTML but with Telegram-like styling
  if (parseMode === 'HTML') {
    // Add CSS classes for Telegram-like styling
    const styledMessage = message
      .replace(/<b>/g, '<strong class="font-bold">')
      .replace(/<\/b>/g, '</strong>')
      .replace(/<i>/g, '<em class="italic">')
      .replace(/<\/i>/g, '</em>')
      .replace(/<u>/g, '<span class="underline">')
      .replace(/<\/u>/g, '</span>')
      .replace(/<s>/g, '<span class="line-through">')
      .replace(/<\/s>/g, '</span>')
      .replace(/<code>/g, '<code class="bg-secondary/50 px-1 py-0.5 rounded text-sm font-mono">')
      .replace(/<\/code>/g, '</code>')
      .replace(/<pre>/g, '<pre class="bg-secondary/50 p-2 rounded text-sm font-mono overflow-x-auto my-2">')
      .replace(/<\/pre>/g, '</pre>')
      .replace(/<blockquote>/g, '<blockquote class="border-l-4 border-primary/50 pl-3 my-2 text-muted-foreground">')
      .replace(/<\/blockquote>/g, '</blockquote>')
      .replace(/\n/g, '<br />');

    return (
      <div
        className="whitespace-pre-wrap break-words"
        dangerouslySetInnerHTML={{ __html: styledMessage }}
      />
    );
  }

  // For MarkdownV2, parse basic markdown
  if (parseMode === 'MarkdownV2') {
    let html = message
      // Escape HTML first
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Bold: *text*
      .replace(/\*([^*]+)\*/g, '<strong class="font-bold">$1</strong>')
      // Italic: _text_
      .replace(/_([^_]+)_/g, '<em class="italic">$1</em>')
      // Underline: __text__
      .replace(/__([^_]+)__/g, '<span class="underline">$1</span>')
      // Strikethrough: ~text~
      .replace(/~([^~]+)~/g, '<span class="line-through">$1</span>')
      // Code: `text`
      .replace(/`([^`]+)`/g, '<code class="bg-secondary/50 px-1 py-0.5 rounded text-sm font-mono">$1</code>')
      // Newlines
      .replace(/\n/g, '<br />');

    return (
      <div
        className="whitespace-pre-wrap break-words"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return <div>{message}</div>;
}

function NotificationsPanel({
  broadcasts,
  onSend,
  onRefresh,
}: {
  broadcasts: BroadcastNotification[];
  onSend: (data: SendBroadcastRequest) => Promise<{ success: boolean; sentCount?: number; failedCount?: number; error?: string }>;
  onRefresh: () => void;
}) {
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [parseMode, setParseMode] = useState<'HTML' | 'MarkdownV2' | 'plain'>('HTML');
  const [targetType, setTargetType] = useState<'all' | 'active' | 'selected'>('all');
  const [selectedUsers, setSelectedUsers] = useState<BroadcastUser[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [searchResults, setSearchResults] = useState<BroadcastUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const searchUsers = async (search: string) => {
    if (!search.trim()) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const data = await getBroadcastUsers(search, 10);
      setSearchResults(data.users);
    } catch (err) {
      console.error('Failed to search users:', err);
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      if (userSearch) searchUsers(userSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [userSearch]);

  const handleAddUser = (user: BroadcastUser) => {
    if (!selectedUsers.find(u => u.id === user.id)) {
      setSelectedUsers([...selectedUsers, user]);
    }
    setUserSearch('');
    setSearchResults([]);
  };

  const handleRemoveUser = (userId: string) => {
    setSelectedUsers(selectedUsers.filter(u => u.id !== userId));
  };

  const handleSend = async () => {
    if (!message.trim()) {
      setResult({ success: false, message: 'Message is required' });
      return;
    }
    if (targetType === 'selected' && selectedUsers.length === 0) {
      setResult({ success: false, message: 'Select at least one user' });
      return;
    }

    setSending(true);
    setResult(null);
    try {
      const response = await onSend({
        title: title.trim() || undefined,
        message: message.trim(),
        parseMode,
        targetType,
        targetUserIds: targetType === 'selected' ? selectedUsers.map(u => u.id) : undefined,
      });

      if (response.success) {
        setResult({
          success: true,
          message: `Sent to ${response.sentCount} user(s)${response.failedCount ? `, ${response.failedCount} failed` : ''}`,
        });
        // Reset form
        setTitle('');
        setMessage('');
        setSelectedUsers([]);
        onRefresh();
      } else {
        setResult({ success: false, message: response.error || 'Failed to send' });
      }
    } catch (err) {
      setResult({ success: false, message: err instanceof Error ? err.message : 'Failed to send' });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Compose Section */}
      <div className="bg-secondary/20 rounded-lg p-4">
        <h3 className="text-lg font-medium mb-4">Send Broadcast</h3>

        <div className="space-y-4">
          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              Title (optional)
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Announcement title..."
              className="w-full px-3 py-2 bg-input border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Message */}
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              Message *
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Your message..."
              rows={4}
              className="w-full px-3 py-2 bg-input border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
          </div>

          {/* Parse Mode */}
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              Format
            </label>
            <div className="flex gap-2">
              {(['HTML', 'MarkdownV2', 'plain'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setParseMode(mode)}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                    parseMode === mode
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* Preview */}
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              Preview
            </label>
            <div className="bg-[#1e2c3a] text-white p-4 rounded-lg min-h-[100px] border border-[#2d3f50]">
              {title && (
                <div className="font-bold text-lg mb-2">{title}</div>
              )}
              <TelegramPreview message={message} parseMode={parseMode} />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              This shows how your message will appear in Telegram
            </p>
          </div>

          {/* Target Type */}
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              Recipients
            </label>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => setTargetType('all')}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                  targetType === 'all'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-muted-foreground hover:text-foreground'
                }`}
              >
                All Users
              </button>
              <button
                onClick={() => setTargetType('active')}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                  targetType === 'active'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-muted-foreground hover:text-foreground'
                }`}
              >
                Active (with subscriptions)
              </button>
              <button
                onClick={() => setTargetType('selected')}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                  targetType === 'selected'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-muted-foreground hover:text-foreground'
                }`}
              >
                Select Users
              </button>
            </div>
          </div>

          {/* User Selection */}
          {targetType === 'selected' && (
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">
                Search & Select Users
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  placeholder="Search by username..."
                  className="w-full px-3 py-2 bg-input border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                {searching && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                    ...
                  </div>
                )}
                {searchResults.length > 0 && (
                  <div className="absolute z-10 w-full mt-1 bg-popover border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {searchResults.map((user) => (
                      <button
                        key={user.id}
                        onClick={() => handleAddUser(user)}
                        className="w-full px-3 py-2 text-left hover:bg-secondary/50 flex items-center justify-between"
                      >
                        <span>{user.username || user.firstName || 'No name'}</span>
                        <span className="text-xs text-muted-foreground">
                          {user._count.subscriptions} subs
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Selected Users */}
              {selectedUsers.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {selectedUsers.map((user) => (
                    <span
                      key={user.id}
                      className="inline-flex items-center gap-1 px-2 py-1 bg-primary/20 text-primary rounded text-sm"
                    >
                      {user.username || user.firstName || 'No name'}
                      <button
                        onClick={() => handleRemoveUser(user.id)}
                        className="hover:text-destructive ml-1"
                      >
                        x
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Result Message */}
          {result && (
            <div className={`p-3 rounded-lg ${result.success ? 'bg-success/20 text-success' : 'bg-destructive/20 text-destructive'}`}>
              {result.message}
            </div>
          )}

          {/* Send Button */}
          <button
            onClick={handleSend}
            disabled={sending || !message.trim()}
            className="px-6 py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? 'Sending...' : 'Send Broadcast'}
          </button>
        </div>
      </div>

      {/* History Section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-medium">Broadcast History</h3>
          <button
            onClick={onRefresh}
            className="px-3 py-1 text-sm bg-secondary text-secondary-foreground rounded hover:bg-secondary/80"
          >
            Refresh
          </button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead>Failed</TableHead>
              <TableHead>Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {broadcasts.map((broadcast) => (
              <TableRow key={broadcast.id}>
                <TableCell className="font-medium">
                  {broadcast.title || <span className="text-muted-foreground">-</span>}
                </TableCell>
                <TableCell>
                  <TruncatedCell value={broadcast.message} maxWidth={200} />
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">
                    {broadcast.targetType}
                    {broadcast.targetType === 'selected' && ` (${broadcast.targetUserIds.length})`}
                  </Badge>
                </TableCell>
                <TableCell className="text-success">{broadcast.sentCount}</TableCell>
                <TableCell className={broadcast.failedCount > 0 ? 'text-destructive' : 'text-muted-foreground'}>
                  {broadcast.failedCount}
                </TableCell>
                <TableCell className="text-muted-foreground">{formatTimeAgo(broadcast.createdAt)}</TableCell>
              </TableRow>
            ))}
            {broadcasts.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  No broadcasts sent yet
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function DiagnosticsPanel({ data, onRefresh, onFailStuck }: {
  data: DiagnosticsData | null;
  onRefresh: () => void;
  onFailStuck: (minAgeMinutes: number) => Promise<void>;
}) {
  const [failingStuck, setFailingStuck] = useState(false);
  const [failStuckResult, setFailStuckResult] = useState<string | null>(null);

  const handleFailStuck = async () => {
    if (!window.confirm('This will mark runs older than 2 hours as failed. Continue?')) return;
    setFailingStuck(true);
    setFailStuckResult(null);
    try {
      await onFailStuck(120);
      setFailStuckResult('Successfully failed stuck runs');
      onRefresh();
    } catch (err) {
      setFailStuckResult(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setFailingStuck(false);
    }
  };

  if (!data) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p>Loading diagnostics...</p>
        <button
          onClick={onRefresh}
          className="mt-4 px-4 py-2 bg-secondary text-secondary-foreground rounded hover:bg-secondary/80"
        >
          Refresh
        </button>
      </div>
    );
  }

  const { summary, runningRuns, queueStats, recentFailures } = data;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-secondary/30 rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Running</p>
          <p className={`text-2xl font-bold ${summary.runningCount > 0 ? 'text-primary' : ''}`}>
            {summary.runningCount}
          </p>
        </div>
        <div className="bg-secondary/30 rounded-lg p-4">
          <p className="text-sm text-muted-foreground">With Warnings</p>
          <p className={`text-2xl font-bold ${summary.runsWithWarnings > 0 ? 'text-warning' : ''}`}>
            {summary.runsWithWarnings}
          </p>
        </div>
        <div className="bg-secondary/30 rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Redis</p>
          <p className={`text-2xl font-bold ${summary.redisConnected ? 'text-success' : 'text-destructive'}`}>
            {summary.redisConnected ? 'Connected' : 'Down'}
          </p>
        </div>
        <div className="bg-secondary/30 rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Active Locks</p>
          <p className="text-2xl font-bold">{summary.activeLocks}</p>
        </div>
        <div className="bg-secondary/30 rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Request Cache</p>
          <p className="text-2xl font-bold">{summary.requestCacheSize}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-4">
        <button
          onClick={onRefresh}
          className="px-4 py-2 bg-secondary text-secondary-foreground rounded hover:bg-secondary/80"
        >
          Refresh Diagnostics
        </button>
        <button
          onClick={handleFailStuck}
          disabled={failingStuck}
          className="px-4 py-2 bg-destructive/20 text-destructive border border-destructive/50 rounded hover:bg-destructive/30 disabled:opacity-50"
        >
          {failingStuck ? 'Failing...' : 'Fail Stuck Runs (>2h)'}
        </button>
        {failStuckResult && (
          <span className={`text-sm ${failStuckResult.includes('Error') ? 'text-destructive' : 'text-success'}`}>
            {failStuckResult}
          </span>
        )}
      </div>

      {/* Running Runs */}
      {runningRuns.length > 0 && (
        <div>
          <h3 className="text-lg font-medium mb-3">Running Subscriptions ({runningRuns.length})</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Subscription</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Lock</TableHead>
                <TableHead>Warnings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runningRuns.map((run) => (
                <TableRow key={run.runId} className={run.warnings.length > 0 ? 'bg-warning/10' : ''}>
                  <TableCell className="font-medium">{run.username}</TableCell>
                  <TableCell>
                    <TruncatedCell value={run.jobTitles} maxWidth={150} />
                  </TableCell>
                  <TableCell>{run.stage}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-2 bg-secondary rounded overflow-hidden">
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${run.progress}%` }}
                        />
                      </div>
                      <span className="text-sm">{run.progress}%</span>
                    </div>
                  </TableCell>
                  <TableCell>{run.durationMinutes}m</TableCell>
                  <TableCell>
                    <Badge variant={run.lockStatus === 'LOCKED' ? 'success' : 'destructive'}>
                      {run.lockStatus}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {run.warnings.length > 0 ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-warning cursor-help">{run.warnings.length} warning(s)</span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <ul className="list-disc pl-4">
                            {run.warnings.map((w, i) => (
                              <li key={i}>{w}</li>
                            ))}
                          </ul>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Queue Stats */}
      {queueStats && (
        <div>
          <h3 className="text-lg font-medium mb-3">Queue Status</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-secondary/20 rounded-lg p-4">
              <h4 className="font-medium mb-2">Collection Queue</h4>
              <div className="grid grid-cols-4 gap-2 text-sm">
                <div><span className="text-muted-foreground">Waiting:</span> {queueStats.collection.waiting}</div>
                <div><span className="text-muted-foreground">Active:</span> {queueStats.collection.active}</div>
                <div><span className="text-muted-foreground">Completed:</span> {queueStats.collection.completed}</div>
                <div><span className="text-muted-foreground">Failed:</span> {queueStats.collection.failed}</div>
              </div>
            </div>
            <div className="bg-secondary/20 rounded-lg p-4">
              <h4 className="font-medium mb-2">Matching Queue</h4>
              <div className="grid grid-cols-4 gap-2 text-sm">
                <div><span className="text-muted-foreground">Waiting:</span> {queueStats.matching.waiting}</div>
                <div><span className="text-muted-foreground">Active:</span> {queueStats.matching.active}</div>
                <div><span className="text-muted-foreground">Completed:</span> {queueStats.matching.completed}</div>
                <div><span className="text-muted-foreground">Failed:</span> {queueStats.matching.failed}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Recent Failures */}
      {recentFailures.length > 0 && (
        <div>
          <h3 className="text-lg font-medium mb-3">Recent Failures (24h)</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Subscription</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Error</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentFailures.map((failure) => (
                <TableRow key={failure.runId}>
                  <TableCell className="font-medium">{failure.username}</TableCell>
                  <TableCell>
                    <TruncatedCell value={failure.jobTitles} maxWidth={150} />
                  </TableCell>
                  <TableCell>{failure.failedStage || '-'}</TableCell>
                  <TableCell>
                    <TruncatedCell value={failure.errorMessage || 'Unknown'} maxWidth={200} className="text-destructive" />
                  </TableCell>
                  <TableCell>{failure.durationSeconds ? `${failure.durationSeconds}s` : '-'}</TableCell>
                  <TableCell className="text-muted-foreground">{formatTimeAgo(failure.startedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Last updated: {data.timestamp ? new Date(data.timestamp).toLocaleString() : '-'}
      </p>
    </div>
  );
}

function Dashboard() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [subscriptionsTotal, setSubscriptionsTotal] = useState(0);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runsPage, setRunsPage] = useState(1);
  const [runsTotalPages, setRunsTotalPages] = useState(1);
  const [runsTotal, setRunsTotal] = useState(0);
  const [errors, setErrors] = useState<ErrorEntry[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsData | null>(null);
  const [broadcasts, setBroadcasts] = useState<BroadcastNotification[]>([]);
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

  const loadDiagnostics = async () => {
    try {
      const data = await getDiagnostics();
      setDiagnostics(data);
    } catch (err) {
      console.error('Failed to load diagnostics:', err);
    }
  };

  const loadBroadcasts = async () => {
    try {
      const data = await getBroadcasts(1, 50);
      setBroadcasts(data.broadcasts);
    } catch (err) {
      console.error('Failed to load broadcasts:', err);
    }
  };

  const handleSendBroadcast = async (data: SendBroadcastRequest): Promise<{ success: boolean; sentCount?: number; failedCount?: number; error?: string }> => {
    try {
      const response = await sendBroadcast(data);
      return {
        success: response.success,
        sentCount: response.broadcast.sentCount,
        failedCount: response.broadcast.failedCount,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to send broadcast',
      };
    }
  };

  const handleFailStuck = async (minAgeMinutes: number) => {
    await failStuckRuns(minAgeMinutes);
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
        setSubscriptionsTotal(subsData.pagination.total);
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

  const handleStartRun = async (subscriptionId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await startSubscriptionRun(subscriptionId);
      // Trigger a refresh to show the new running state
      const runsData = await getRuns(1, 100);
      setRuns(runsData.runs);
      return { success: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to start run';
      console.error('Failed to start run:', err);
      return { success: false, error: errorMessage };
    }
  };

  const handleStopRun = async (runId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await stopRun(runId);
      // Trigger a refresh to show the stopped state
      const runsData = await getRuns(runsPage, 100);
      setRuns(runsData.runs);
      return { success: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to stop run';
      console.error('Failed to stop run:', err);
      return { success: false, error: errorMessage };
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
              <TabsTrigger value="subscriptions">Subscriptions ({subscriptionsTotal})</TabsTrigger>
              <TabsTrigger value="runs">Runs ({runsTotal})</TabsTrigger>
              <TabsTrigger value="errors">
                Errors ({errors.length})
                {errors.length > 0 && <span className="ml-1 w-2 h-2 rounded-full bg-destructive inline-block" />}
              </TabsTrigger>
              <TabsTrigger value="diagnostics" onClick={loadDiagnostics}>
                Diagnostics
              </TabsTrigger>
              <TabsTrigger value="notifications" onClick={loadBroadcasts}>
                Notifications
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
                  <SubscriptionsTable subscriptions={subscriptions} onDebugToggle={handleDebugToggle} onStartRun={handleStartRun} />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="runs" className="mt-4">
              <Card>
                <CardContent className="pt-6">
                  <RunsTable runs={runs} onStopRun={handleStopRun} />
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

            <TabsContent value="diagnostics" className="mt-4">
              <Card>
                <CardContent className="pt-6">
                  <DiagnosticsPanel
                    data={diagnostics}
                    onRefresh={loadDiagnostics}
                    onFailStuck={handleFailStuck}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="notifications" className="mt-4">
              <Card>
                <CardContent className="pt-6">
                  <NotificationsPanel
                    broadcasts={broadcasts}
                    onSend={handleSendBroadcast}
                    onRefresh={loadBroadcasts}
                  />
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
