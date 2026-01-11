# AI Job Finder

AI-powered job aggregation and matching system that collects jobs from multiple sources, analyzes them against a user's resume using LLM, and returns match scores with detailed reasoning.

> **Note**: We use the free JobSpy scraper as the primary data source. All optimizations and solutions should target JobSpy first. SerpAPI is available but requires a paid API key.

## Critical Rules

- **NEVER** include AI-generated footers in git commits. Do not add "Generated with Claude Code", "Co-Authored-By: Claude", or similar attribution lines to commit messages.

- **NEVER ask the user to do things manually.** Always use SSH (`ssh root@49.12.207.132`) to fix production issues directly. This includes:
  - Updating Dokploy compose files (edit the database directly via `docker exec dokploy-postgres.1.* psql`)
  - Restarting containers
  - Fixing database credentials
  - Modifying configuration files
  - Any server-side operations

- **NEVER rotate credentials automatically.** If secrets are accidentally exposed (e.g., committed to git), flag the issue and let the user rotate credentials manually through the appropriate service UI (Langfuse, etc.). Automated credential rotation is risky and could break production systems.

- **ALWAYS use the latest versions** of packages, Docker images, and dependencies. When adding new dependencies or updating compose files, use `latest` tags or the most recent stable version. Don't pin to old versions unless there's a specific compatibility requirement.

- **ALWAYS test schema migrations against production data BEFORE deploying.** Adding required columns without defaults will fail on tables with existing rows. Before any schema change:
  1. Check if the table has existing data: `SELECT COUNT(*) FROM table_name;`
  2. New columns MUST be either nullable (`String?`) or have a default value (`@default(now())`)
  3. `@updatedAt` fields are required by Prisma and CANNOT have defaults - don't add them to tables with existing data
  4. Test the migration locally with a copy of production data if possible

## Quick Start

**Requirements:** Node.js 20+ (required for Prisma)

```bash
# Ensure Node 20+ (required for Prisma client generation)
node --version  # Should be v20.x or higher
nvm use 20      # If using nvm

# Start database
docker compose up -d

# Install dependencies
npm install

# Initialize database
npx prisma db push

# Run development server
npm run dev
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (basic) |
| `/health/detailed` | GET | Detailed health check (DB, Redis, run failure rate) |
| `/search` | POST | Search jobs and analyze matches |
| `/jobs` | GET | List all collected jobs |
| `/matches` | GET | List all job matches with scores |
| `/queue/status` | GET | Queue monitoring (waiting/active/completed counts) |
| `/admin` | GET | Admin dashboard (requires `ADMIN_API_KEY` header) |
| `/admin/api/overview` | GET | Dashboard overview stats |
| `/admin/api/users` | GET | List users with subscription counts |
| `/admin/api/subscriptions` | GET | List all subscriptions |
| `/admin/api/runs` | GET | Recent subscription runs with error details |
| `/admin/api/runs/active` | GET | Currently running subscriptions with progress |

## Example: Search Jobs

```bash
# Basic search (uses JobSpy by default)
curl -X POST http://localhost:3001/search \
  -H "Content-Type: application/json" \
  -d '{
    "jobTitles": ["Senior Software Engineer"],
    "location": "United States",
    "isRemote": true,
    "source": "jobspy",
    "resumeText": "Your resume text here...",
    "limit": 100
  }'

# Collect jobs, match top 10 (fast test)
curl -X POST http://localhost:3001/search \
  -H "Content-Type: application/json" \
  -d '{
    "jobTitles": ["Software Engineer", "Backend Developer"],
    "location": "United States",
    "isRemote": true,
    "source": "jobspy",
    "limit": 200,
    "matchLimit": 10,
    "resumeText": "Your resume..."
  }'

# Force fresh fetch (skip cache)
curl -X POST http://localhost:3001/search \
  -H "Content-Type: application/json" \
  -d '{
    "jobTitles": ["Backend Developer"],
    "source": "jobspy",
    "skipCache": true,
    "limit": 50,
    "resumeText": "..."
  }'

# Wider search (LLM expands job titles + suggests based on resume)
# Note: widerSearch is limited to original titles for JobSpy to avoid rate limits
curl -X POST http://localhost:3001/search \
  -H "Content-Type: application/json" \
  -d '{
    "jobTitles": ["Backend Engineer"],
    "source": "jobspy",
    "widerSearch": true,
    "limit": 200,
    "matchLimit": 20,
    "resumeText": "Senior engineer with Python, Django, AWS..."
  }'
```

## Architecture

```
src/
├── index.ts              # Express server entry point
├── config.ts             # Environment config (Zod validated)
├── core/
│   ├── types.ts          # Shared TypeScript types
│   └── interfaces.ts     # IService, IAgent interfaces (DRY)
├── services/
│   ├── collector.ts      # JobSpy/SerpAPI job collection (JobSpy primary)
│   └── normalizer.ts     # Job deduplication & normalization
├── agents/
│   ├── matcher.ts            # LLM-based job matching (score 1-100)
│   ├── query-expander.ts     # LLM-based query expansion for wider search
│   └── location-normalizer.ts # LLM-based location parsing & normalization
├── llm/
│   └── client.ts         # OpenRouter client with structured outputs
├── api/
│   └── routes.ts         # Express routes with logging
├── db/
│   └── client.ts         # Prisma singleton
├── queue/                # Bull queue for rate-limited job processing
│   ├── redis.ts          # Redis connection management
│   ├── queues.ts         # Queue definitions (collection, matching)
│   ├── service.ts        # QueueService with fallback to p-limit
│   └── workers/
│       ├── collection.ts # JobSpy/SerpAPI worker (concurrency: 2)
│       └── matching.ts   # LLM matching worker (concurrency: 5)
├── scheduler/
│   ├── cron.ts           # Per-minute scheduler + stuck run cleanup
│   └── jobs/
│       └── search-subscriptions.ts  # Subscription search logic
├── telegram/
│   ├── bot.ts            # Telegram bot initialization
│   ├── handlers/         # Command and callback handlers
│   └── services/         # Notification services
├── observability/        # Run tracking and analytics
│   ├── index.ts          # Module exports
│   ├── tracker.ts        # RunTracker for subscription execution
│   ├── analytics.ts      # Skill stats and market insights
│   └── cleanup.ts        # Old data cleanup scheduler
├── admin/                # Admin dashboard
│   ├── index.ts          # Module exports
│   ├── routes.ts         # Admin API routes (auth protected)
│   └── dashboard.ts      # HTML dashboard generator
├── schemas/
│   └── llm-outputs.ts    # Zod schemas for LLM responses
└── utils/
    └── logger.ts         # Logging utility
```

### Request Flow

```
                    +------------------+
                    |   Entry Points   |
                    +------------------+
                           |
       +-------------------+-------------------+
       |                   |                   |
  API /search       Telegram Scan      Scheduled Run
       |                   |                   |
       v                   v                   v
+------------------------------------------------------+
|                   Bull Queue (Redis)                  |
|  +----------------+  +----------------+               |
|  | collection     |  | matching       |               |
|  | (concurrency:2)|  | (concurrency:5)|               |
|  +----------------+  +----------------+               |
+------------------------------------------------------+
       |                   |
       v                   v
   JobSpy API         OpenRouter LLM
```

## Key Concepts

### Services vs Agents
- **Services**: No LLM, deterministic (CollectorService, NormalizerService)
- **Agents**: Use LLM, require verification (MatcherAgent, QueryExpanderAgent, LocationNormalizerAgent)

### Agent Architecture

This codebase uses a **simple custom agent pattern** - NOT LangGraph or LangChain. Each agent:
1. Takes structured input
2. Calls LLM with a specific prompt
3. Validates output with Zod schemas
4. Returns typed results

**Why not LangGraph/LangChain?**
- Our agents are single-turn (no complex state machines)
- Zod validation is simpler and more reliable than framework abstractions
- Direct OpenRouter calls give full control over prompts and retries
- Less abstraction = easier debugging

**Available Agents:**
| Agent | Purpose |
|-------|---------|
| `MatcherAgent` | Score jobs against resume (1-100) |
| `QueryExpanderAgent` | Expand job titles with synonyms |
| `LocationNormalizerAgent` | Parse natural location input |

### Location Normalization

Users can input locations naturally, and the LLM parses them into structured data:

```
Input:  "NYC, Boston, and remote"
Output: [
  { display: "New York, NY, USA", type: "physical", searchVariants: ["New York", "NYC"] },
  { display: "Boston, MA, USA", type: "physical", searchVariants: ["Boston"] },
  { display: "Remote", type: "remote" }
]
```

**Features:**
- Multi-location support ("NYC, LA, and Austin")
- Remote job filtering ("Remote" or "SF or Remote")
- Ambiguity clarification (asks user if input is unclear)
- Search variant expansion (NYC → "New York", "NYC", "New York City")

**Data flow:**
1. User enters location text in Telegram
2. `LocationNormalizerAgent.parse()` calls LLM
3. If ambiguous → bot asks clarifying question
4. User confirms parsed locations
5. Stored as `normalizedLocations` JSON in database
6. Collector searches each location + variants
7. Results filtered to match user's locations

### Job Type Filtering

Users can filter jobs by employment type during Telegram subscription setup:

**Supported job types:**
- `fulltime` - Full-time positions
- `parttime` - Part-time positions
- `internship` - Internship positions
- `contract` - Contract/freelance positions

**How it works:**
1. User selects one or more job types during subscription setup (step 6/9)
2. Empty selection = search all job types (no filter)
3. If multiple types selected, separate searches are made per type
4. Results are merged and deduplicated

**Indeed API Limitation:**
Indeed's API only allows one filter at a time from: `hours_old`, `job_type`, `is_remote`, `easy_apply`.
To work around this, we use an **intersection approach**:
1. Search 1: Query with `hours_old` (gets recent jobs)
2. Search 2: Query with `job_type` + `is_remote` (gets filtered jobs)
3. Intersect results by job URL to get jobs matching all criteria

This ensures users get recent jobs that also match their job type and remote preferences.

### Telegram Subscription Flow

The subscription setup in Telegram follows a 9-step conversation flow:

| Step | Name | Description |
|------|------|-------------|
| 1/9 | Job Titles | Enter job titles to search for (comma-separated) |
| 2/9 | Location | Enter location(s) naturally (e.g., "NYC, Remote") |
| 3/9 | Location Confirmation | Confirm parsed locations from LLM |
| 4/9 | Date Range | Select how recent jobs should be (24h to 30 days) |
| 5/9 | Min Score | Set minimum match score threshold (1-100) |
| 6/9 | Job Type | Select job types (Full-time, Part-time, etc.) |
| 7/9 | Exclusions | Optional: exclude specific titles/companies |
| 8/9 | Resume | Upload PDF or paste resume text |
| 9/9 | Confirmation | Review and confirm subscription |

**Key files:**
- `src/telegram/handlers/conversation.ts` - Main conversation flow logic
- `src/telegram/handlers/commands.ts` - Bot commands and callback handlers
- `src/telegram/services/document.ts` - Resume upload handling

### Job Match Score (1-100)
- 90-100: Perfect match
- 70-89: Strong match
- 50-69: Moderate match
- 30-49: Weak match
- 1-29: Poor match

### Structured LLM Outputs
All LLM responses are validated with Zod schemas to prevent hallucinations.

## Environment Variables

```bash
# Required
DATABASE_URL=postgresql://user:pass@localhost:5433/jobfinder
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=xiaomi/mimo-v2-flash:free

# JobSpy (Primary - Free scraper)
JOBSPY_URL=http://localhost:8000
# Production: https://jobspy.49-12-207-132.sslip.io

# SerpAPI (Optional - Paid)
SERPAPI_API_KEY=...

# Redis (Optional - enables Bull queue)
REDIS_URL=redis://localhost:6379

# Queue configuration
QUEUE_JOBSPY_CONCURRENCY=2      # Max concurrent JobSpy requests
QUEUE_LLM_CONCURRENCY=5         # Max concurrent LLM calls
QUEUE_FALLBACK_ENABLED=true     # Fallback to in-process p-limit if Redis unavailable

# Collection settings
COLLECTION_CIRCUIT_BREAKER_THRESHOLD=3  # Open circuit after N consecutive failures (fail fast)

# Scheduling
SUBSCRIPTION_INTERVAL_HOURS=1   # Hours between subscription runs

# Server
PORT=3001
LOG_LEVEL=info  # debug | info | warn | error (default: info)

# Admin Dashboard
ADMIN_API_KEY=your-secret-key  # Required for /admin access

# Langfuse (LLM Observability - Self-Hosted)
LANGFUSE_PUBLIC_KEY=pk-lf-...  # From Langfuse dashboard after first login
LANGFUSE_SECRET_KEY=sk-lf-...  # From Langfuse dashboard after first login
LANGFUSE_BASE_URL=https://langfuse.49-12-207-132.sslip.io  # Self-hosted instance

# Sentry (Full Observability - Optional)
SENTRY_DSN=https://xxx@sentry.io/xxx  # From Sentry project
SENTRY_ENVIRONMENT=development  # development | production
SENTRY_TRACES_SAMPLE_RATE=0.1  # Base trace sampling (0.0-1.0, default: 0.1)
SENTRY_PROFILES_SAMPLE_RATE=0.1  # CPU profiling sampling (0.0-1.0, default: 0.1)
# Note: Subscription runs are always sampled at 100%, health checks at 1%

# Source Maps Upload (for readable stack traces in Sentry)
SENTRY_AUTH_TOKEN=...  # From https://sentry.io/settings/auth-tokens/
SENTRY_ORG=your-org    # Sentry organization slug
SENTRY_PROJECT=your-project  # Sentry project slug
```

## Data Sources

### JobSpy (Primary - Free)
- Scrapes Indeed, LinkedIn, Glassdoor, ZipRecruiter directly
- Requires separate Python microservice (see `jobspy-service/`)
- Set `JOBSPY_URL` env var (e.g., `http://localhost:8000`)
- Use `source: "jobspy"` in search requests
- Rate limited: max 2 concurrent requests via Bull queue (or p-limit fallback)
- **Indeed limitation**: Only one filter from `hours_old`, `job_type`, `is_remote`, `easy_apply` per search
  - We use intersection-based searches to combine these filters (see "Job Type Filtering" section)

### SerpAPI Google Jobs (Optional - Paid)
- Aggregates jobs from LinkedIn, Indeed, Glassdoor, etc.
- Requires `SERPAPI_API_KEY` env var
- Use `source: "serpapi"` in search requests
- ~10 jobs per page, up to 100 pages

## Query Caching

To optimize API costs, queries are cached for 6 hours by default:
- Cache key = hash(query + location + isRemote + source)
- Cached results are stored in PostgreSQL
- Use `skipCache: true` to force fresh fetch
- Use `cacheHours: N` to customize TTL

## Wider Search (Query Expansion)

Use `widerSearch: true` to automatically expand job titles using LLM:

```
Input:  ["Backend Engineer", "DevOps Engineer"]
Output:
  fromExpansion: ["Backend Engineer", "Backend Developer", "DevOps Engineer", "Platform Engineer"]
  fromResume:    ["Senior Backend Engineer", "Cloud Engineer", "SRE", ...]
  total: ~9 unique titles searched
```

**How it works:**
- **fromExpansion**: Original titles + 1 synonym per title (conservative to reduce duplicates)
- **fromResume**: Max 5 additional titles based on resume skills/experience level
- Results are cached to avoid repeated LLM calls
- Response includes `expansion` object showing all searched titles

## Score Filtering

Use `minScore` to filter out low-scoring matches (default: 40):

```bash
curl -X POST http://localhost:3001/search \
  -H "Content-Type: application/json" \
  -d '{
    "jobTitles": ["Software Engineer"],
    "minScore": 70,
    "resumeText": "..."
  }'
```

Response includes `jobsFiltered` count showing how many were below threshold.

## CSV Export

Search results are automatically saved to CSV files in the `exports/` directory:
- Filename: `job-matches-{timestamp}.csv`
- Accessible via: `http://localhost:3001/exports/{filename}`
- Response includes `downloadUrl` for direct download

## Tech Stack
- TypeScript, Node.js, Express
- PostgreSQL + Prisma ORM
- Redis + Bull (Job queue)
- OpenRouter (LLM) - xiaomi/mimo-v2-flash:free
- JobSpy (Free scraper - primary)
- SerpAPI (Paid aggregator - optional)
- Zod (Validation)
- ioredis + Bull (Queue) or p-limit (Fallback rate limiting)

## Queue System

The queue system prevents rate limiting when multiple users trigger searches simultaneously.

### How It Works
- **Bull + Redis**: All JobSpy and LLM requests go through rate-limited queues
- **Collection Queue**: Max 2 concurrent JobSpy requests (prevents 429 errors)
- **Matching Queue**: Max 5 concurrent LLM calls (controls costs)
- **Priority Levels**: Manual scans (1) > API requests (2) > Scheduled runs (3)

### Fallback Mode
If Redis is unavailable, the system falls back to in-process `p-limit` rate limiting.
This provides graceful degradation but doesn't share limits across instances.

### Monitoring
```bash
# Check queue status
curl http://localhost:3001/queue/status

# Response:
{
  "status": "active",
  "queues": {
    "collection": { "waiting": 5, "active": 2, "completed": 100 },
    "matching": { "waiting": 20, "active": 5, "completed": 500 }
  }
}
```

### Circuit Breaker
The collection phase includes a circuit breaker to fail fast when JobSpy is unavailable:

- **Threshold**: Opens after 3 consecutive query failures (configurable via `COLLECTION_CIRCUIT_BREAKER_THRESHOLD`)
- **Behavior**: When circuit opens, remaining queries are skipped immediately
- **Benefit**: Prevents wasting 30+ minutes on timeouts when all queries would fail anyway
- **Recovery**: Any successful query resets the consecutive failure counter

Example scenario with 21 queries:
- Without circuit breaker: All 21 queries timeout → 63 minutes wasted (21 × 3 min)
- With circuit breaker: First 3 queries timeout → circuit opens → 18 queries skipped → ~9 minutes total

## Subscription Scheduler

Users subscribe to job searches via Telegram. The scheduler processes each subscription independently.

### Staggered Scheduling
- Each subscription has its own `nextRunAt` timestamp
- Scheduler checks every minute for due subscriptions (`nextRunAt <= now`)
- After processing, `nextRunAt` is set to `now + SUBSCRIPTION_INTERVAL_HOURS`
- Natural load distribution: users subscribe at different times

### Why Not Batch Processing?
The old approach ran all subscriptions at the same fixed time (e.g., hourly at :00).
Problems:
- Thundering herd: all requests hit JobSpy/LLM simultaneously
- Queue backup: late subscribers wait for earlier ones
- Unfair priority: all jobs have equal priority

The new per-subscription approach:
- Spreads load naturally across time
- Manual scans get priority (jump the queue)
- No waiting for other users' jobs

## Observability

The system uses a multi-layered observability stack:

| Layer | Tool | Purpose |
|-------|------|---------|
| **LLM Observability** | Langfuse | Token costs, prompt debugging, latency tracking |
| **Error Tracking** | Sentry | Exception capture, alerting, stack traces |
| **Run Tracking** | Custom (PostgreSQL) | Subscription execution stats, progress |
| **Admin Dashboard** | Custom (Express) | Live monitoring, diagnostics |

### Langfuse (LLM Observability)

Tracks all LLM calls with:
- Token usage and cost per call
- Latency metrics
- Input/output logging for debugging
- Error tracking
- Full trace context linking LLM calls to subscriptions

**Trace Context Flow:**
All job matching LLM calls include rich context for debugging:

| Field | Description |
|-------|-------------|
| `traceName` | Operation name (`job-matching`) |
| `traceUserId` | subscriptionId - groups all traces by subscription |
| `traceSessionId` | runId - groups traces within a single run |
| `traceMetadata` | Job details: subscriptionId, runId, userId, jobTitle, company, contentHash |

The trace context flows through the entire queue system:
1. `search-subscriptions.ts` → `batchProcessor.processAll()` with trace context
2. `batch-processor.ts` → `queueService.enqueueMatching()` passes trace context
3. `service.ts` → Bull queue job data includes trace context
4. `matching.ts` worker → `matcher.execute()` with trace context
5. `matcher.ts` → `callLLM()` with full Langfuse trace context

This enables:
- Filtering traces by subscription/user in Langfuse dashboard
- Tracking LLM costs per subscription
- Debugging specific job matching issues by job title/company
- Understanding which jobs are expensive to match

View traces at: https://cloud.langfuse.com (or your self-hosted instance)

### Langfuse MCP Tools

Query Langfuse data directly from Claude Code using MCP tools:

| Tool | Description |
|------|-------------|
| `fetch_traces(age)` | Get LLM call traces for last N minutes |
| `fetch_trace(trace_id)` | Get single trace with full details |
| `fetch_sessions(age)` | List sessions (grouped by runId) |
| `get_session_details(session_id)` | Get all traces for a session/run |
| `get_user_sessions(user_id, age)` | Get sessions for a specific user |
| `find_exceptions(age)` | Get exception counts by file/function |
| `get_error_count(age)` | Count traces with errors |
| `list_prompts()` / `get_prompt(name)` | Prompt management |

**Common Queries:**
```
# Get traces from last 24 hours
mcp__langfuse__fetch_traces(age=1440)

# Get all traces for a subscription run
mcp__langfuse__get_session_details(session_id="<runId>")

# Check errors in last hour
mcp__langfuse__get_error_count(age=60)

# Get trace with observations (token counts, latency)
mcp__langfuse__fetch_trace(trace_id="<id>", include_observations=true)
```

**Known Issue (langfuse-mcp v0.3.1):**
`get_session_details` fails with `DateTime64` error on self-hosted Langfuse. Fix: patch `~/.cache/uv/archive-v0/*/langfuse_mcp/__main__.py` line 1518, change `datetime.fromtimestamp(0, tz=timezone.utc)` to `None`. Restart Claude Code after patching.

### Sentry (Full Observability)

Comprehensive error tracking, performance monitoring, and business metrics:

**Error Tracking:**
- All unhandled exceptions (uncaughtException, unhandledRejection)
- Subscription run failures with full context (stage, query, location)
- API errors from JobSpy, SerpAPI, OpenRouter
- Telegram bot errors with user context
- PII scrubbing for resume text in error reports

**Performance Monitoring:**
- Custom spans for queue workers (collection, matching)
- LLM call spans with token usage and latency
- External API spans for JobSpy and SerpAPI
- Dynamic sampling: 100% for subscription runs, 1% for health checks

**Business Metrics (Sentry Insights):**
| Metric | Type | Description |
|--------|------|-------------|
| `jobs.collected` | Counter | Jobs collected by source (jobspy/serpapi) |
| `jobs.matched` | Counter | Jobs matched per subscription |
| `notifications.sent` | Counter | Telegram notifications sent |
| `subscription.run.completed` | Counter | Runs by success/failure and trigger type |
| `subscription.run.duration` | Distribution | Run duration in milliseconds |
| `llm.latency` | Distribution | LLM call latency by operation |
| `llm.tokens` | Counter | Token usage by operation |
| `match.cache` | Counter | Cache hit/miss ratio |
| `match.score` | Distribution | Job match score distribution |
| `api.errors` | Counter | API errors by service and type |

**User Context:**
- Subscription runs tagged with userId, username, subscriptionId
- Telegram bot errors include user info
- Breadcrumb trail for debugging (run stages, API calls, LLM calls)

**Helper Functions (`src/utils/sentry.ts`):**
```typescript
// Set user context for a subscription run
setSubscriptionContext(subscription);

// Add breadcrumbs for operation trail
addRunStageBreadcrumb('collection', 'Collected 50 jobs');
addQueueBreadcrumb('matching', 'process', { jobTitle, company });
addLLMBreadcrumb('job-matching', { latencyMs, tokens });
addApiCallBreadcrumb('JobSpy', 'search', { query, location });

// Clear user context after run
clearSentryUser();
```

**Source Maps:**
Source maps are generated during build. To upload to Sentry for readable stack traces:
```bash
# Set required env vars
export SENTRY_AUTH_TOKEN=your-token
export SENTRY_ORG=your-org
export SENTRY_PROJECT=your-project

# Upload after build
./scripts/sentry-release.sh
```

Errors from `RunTracker.fail()` are automatically sent to Sentry with full context.

### Run Tracking (Custom)

The system tracks every subscription run for debugging and analytics.

### Run Tracking

Every subscription execution (scheduled or manual) creates a `SubscriptionRun` record:

```typescript
// Start tracking
const runId = await RunTracker.start(subscriptionId, 'scheduled');

// Update progress
await RunTracker.update(runId, { jobsCollected: 50 });

// Complete with final stats
await RunTracker.complete(runId, { jobsCollected: 50, jobsMatched: 5, notificationsSent: 3 });

// Or fail with error context
await RunTracker.fail(runId, error, {
  stage: 'collection',
  query: 'Software Engineer',
  location: 'Remote',
  partialResults: { jobsCollected: 0 }
});
```

### Error Context

When runs fail, structured context is captured for debugging:

| Field | Description |
|-------|-------------|
| `stage` | Where it failed: `collection`, `normalization`, `matching`, `notification` |
| `query` | Job title being searched |
| `location` | Location being searched |
| `jobTitle` / `company` | Specific job being processed (for matching failures) |
| `partialResults` | Progress before failure (collected/normalized/matched counts) |
| `queueJobId` | Bull queue job ID |
| `requestId` | Request correlation ID |

### Stuck Run Cleanup

A cron job runs every 5 minutes with three tiers of stuck detection:

**Tier 1: No Progress At All (2 hours)**
- Detects runs with `status: 'running'` + `jobs_collected=0` + `collection_queries_total=0` + `checkpoint=NULL`
- Catches runs that got stuck before doing anything (queue issues, early failures)
- Fails the run and schedules immediate retry

**Tier 2: Stalled Progress (2 hours)**
- Uses `lastProgressAt` timestamp to detect runs that stopped making progress
- Detects runs where `lastProgressAt` is >2 hours ago but status is still `running`
- Only applies to runs that started making progress (has jobs, queries, or checkpoint)
- Fails the run and schedules immediate retry

**Tier 3: Legacy Crash Recovery (24 hours)**
- Any run with `status: 'running'` for >24 hours is marked as failed
- Acts as a safety net for edge cases not caught by Tier 1/2

All tiers:
- Release subscription locks to allow re-runs
- Schedule immediate retry via `nextRunAt = NOW()`
- Log cleanup actions for visibility

### Preventing Duplicate Runs

In-memory tracking prevents the same subscription from running twice:
```typescript
if (!markSubscriptionRunning(subscriptionId)) {
  return; // Already running, skip
}
try {
  await processSubscription(subscriptionId);
} finally {
  markSubscriptionFinished(subscriptionId);
}
```

## Admin Dashboard

Access the admin dashboard at `/admin` with the `ADMIN_API_KEY` header.

### Features

**Period Selection:**
- Choose time range: 24 hours, 7 days, 30 days, or all time
- Activity metrics update based on selected period
- Period comparison shows % change vs previous period (e.g., "Last 7d vs Previous 7d")

**Overview Cards:**
- Total users, active today, new this week
- Subscription counts (total, active, paused)
- Activity metrics (jobs scanned, matches, notifications) with % change indicators
- Failed runs count with failure rate

**Tabs:**
- **Users**: List of users with subscription counts and activity
- **Subscriptions**: All subscriptions with status, last/next run times
- **Runs**: Recent subscription runs with expandable error details

### Viewing Failed Runs

Click on any failed run row to expand error details showing:
- Error message
- Failed stage (collection/normalization/matching/notification)
- Query and location being searched
- Progress before failure
- Specific job being processed (for matching failures)
- Full JSON context for deep debugging

### API Access

All admin endpoints require the `X-Admin-Key` header:

```bash
# Get overview with default period (24h)
curl -H "X-Admin-Key: your-key" http://localhost:3001/admin/api/overview

# Get overview for specific period with comparison
curl -H "X-Admin-Key: your-key" "http://localhost:3001/admin/api/overview?period=7d&compare=true"
# Supported periods: 24h, 7d, 30d, all

# Get recent runs with error context
curl -H "X-Admin-Key: your-key" http://localhost:3001/admin/api/runs
```

## Production Access (Dokploy)

The app is deployed on Dokploy. Use MCP tools or direct database access for debugging.

### Dokploy MCP Tools
```
# List all projects
mcp__dokploy-mcp__project-all

# Get specific project details
mcp__dokploy-mcp__project-one (projectId: "k6eBmZX5lnUQKO6hIG4rx")

# Get application details (includes env vars, deployments)
mcp__dokploy-mcp__application-one (applicationId: "WwAhBC4wwMePhxOWcdA0x")

# Get postgres details (includes credentials)
mcp__dokploy-mcp__postgres-one (postgresId: "JgLBkbIA5CiiSLNvw2DJW")
```

### Direct Production Database Access
```bash
# Connect to production PostgreSQL
PGPASSWORD="jobfinder-prod-2024" psql -h 49-12-207-132.sslip.io -p 5433 -U jobfinder -d jobfinder

# Example: Check user subscriptions
PGPASSWORD="jobfinder-prod-2024" psql -h 49-12-207-132.sslip.io -p 5433 -U jobfinder -d jobfinder -c "
SELECT u.username, s.id, s.is_active, s.next_run_at, s.last_search_at
FROM telegram_users u
JOIN search_subscriptions s ON u.id = s.user_id
WHERE u.username ILIKE '%USERNAME%';
"

# Example: Check subscription runs
PGPASSWORD="jobfinder-prod-2024" psql -h 49-12-207-132.sslip.io -p 5433 -U jobfinder -d jobfinder -c "
SELECT id, status, trigger_type, started_at, completed_at, jobs_collected, error_message
FROM subscription_runs
WHERE subscription_id = 'SUB_ID'
ORDER BY started_at DESC LIMIT 5;
"
```

### Production API Endpoints
```bash
# Health check
curl https://ai-job-finder.49-12-207-132.sslip.io/health

# Queue status
curl https://ai-job-finder.49-12-207-132.sslip.io/queue/status

# Admin dashboard (requires API key)
curl -H "X-Admin-Key: 0d5957a79527672e0c85ba5eb09ccd1c8d53a3006178527e6767642ebc8d2a88" \
  https://ai-job-finder.49-12-207-132.sslip.io/admin/api/overview
```

### Key Production IDs
| Resource | ID |
|----------|-----|
| Project | k6eBmZX5lnUQKO6hIG4rx |
| API Application | WwAhBC4wwMePhxOWcdA0x |
| JobSpy Application | oUAtxv2saqf6YDD2p1vAZ |
| PostgreSQL | JgLBkbIA5CiiSLNvw2DJW |
| Redis | gO3wRu7MzirhB3-ckVxXF |
| Environment | Kro5pHv7mnTIcyRZ33Z7K |

## Pre-Deploy Checklist

Before deploying schema or dependency changes:

### Database Migrations
1. **New required columns**: Always make new columns optional (`String?`) or provide a default value
2. **Unique constraints**: Never add `@@unique` on nullable fields with existing data - use `@@index` instead
3. **Test migrations locally**: Run `npx prisma db push` against a copy of prod data before deploying
4. **Check existing data**: Query `SELECT COUNT(*)` to know if tables have data that could conflict

```bash
# Quick check before adding constraints
npx prisma db execute --stdin <<< "SELECT COUNT(*) FROM job_matches;"
```

### Dependencies
1. **Native binaries**: Avoid packages requiring native compilation (e.g., `@napi-rs/*`) in Docker
2. **Docker slim images**: `node:20-slim` lacks build tools - use pure JS alternatives
3. **Test in Docker locally**: `docker build . && docker run -it <image>` before pushing
4. **Version pins**: Check package changelogs for breaking API changes (e.g., pdf-parse v1 vs v2)

### Before Every Push
1. **ALWAYS run `npm run build`** before committing/pushing to catch TypeScript errors
2. Schema changes may break code (e.g., removing `@@unique` removes composite key types)
3. If build fails on deploy, check Dokploy logs for the actual error message

### Node Version
- **Prisma requires Node 20+** for client generation
- If you see corrupted Prisma output or CLI errors, check `node --version`
- Use `nvm use 20` before running `npx prisma generate` or `npx prisma db push`

### After Every Task Completion
**ALWAYS update documentation** when completing tasks that:
- Add new features or endpoints
- Change architecture or data flow
- Add new environment variables
- Modify database schema
- Add new observability/debugging capabilities

Update these files as needed:
1. `CLAUDE.md` - Technical docs for AI assistants and developers
2. `README.md` - User-facing docs (if applicable)

This ensures the codebase remains self-documenting and future development is easier.
