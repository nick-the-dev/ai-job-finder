# AI Job Finder

AI-powered job aggregation and matching system that collects jobs from multiple sources, analyzes them against a user's resume using LLM, and returns match scores with detailed reasoning.

> **Note**: We use the free JobSpy scraper as the primary data source. All optimizations and solutions should target JobSpy first. SerpAPI is available but requires a paid API key.

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
| `/health` | GET | Health check |
| `/search` | POST | Search jobs and analyze matches |
| `/jobs` | GET | List all collected jobs |
| `/matches` | GET | List all job matches with scores |
| `/queue/status` | GET | Queue monitoring (waiting/active/completed counts) |
| `/admin` | GET | Admin dashboard (requires `ADMIN_API_KEY` header) |
| `/admin/api/overview` | GET | Dashboard overview stats |
| `/admin/api/users` | GET | List users with subscription counts |
| `/admin/api/subscriptions` | GET | List all subscriptions |
| `/admin/api/runs` | GET | Recent subscription runs with error details |

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

# SerpAPI (Optional - Paid)
SERPAPI_API_KEY=...

# Redis (Optional - enables Bull queue)
REDIS_URL=redis://localhost:6379

# Queue configuration
QUEUE_JOBSPY_CONCURRENCY=2      # Max concurrent JobSpy requests
QUEUE_LLM_CONCURRENCY=5         # Max concurrent LLM calls
QUEUE_FALLBACK_ENABLED=true     # Fallback to in-process p-limit if Redis unavailable

# Scheduling
SUBSCRIPTION_INTERVAL_HOURS=1   # Hours between subscription runs

# Server
PORT=3001
LOG_LEVEL=info  # debug | info | warn | error (default: info)

# Admin Dashboard
ADMIN_API_KEY=your-secret-key  # Required for /admin access
```

## Data Sources

### JobSpy (Primary - Free)
- Scrapes Indeed, LinkedIn, Glassdoor, ZipRecruiter directly
- Requires separate Python microservice (see `jobspy-service/`)
- Set `JOBSPY_URL` env var (e.g., `http://localhost:8000`)
- Use `source: "jobspy"` in search requests
- Rate limited: max 2 concurrent requests via Bull queue (or p-limit fallback)

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

A cron job runs every 5 minutes to detect and fail stuck runs:
- Runs with `status: 'running'` for >24 hours are marked as failed
- Prevents zombie runs from blocking the system
- Logs cleanup actions for visibility

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

**Overview Cards:**
- Total users, active today, new this week
- Subscription counts (total, active, paused)
- 24h activity (jobs scanned, matches, notifications)
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

All admin endpoints require the `ADMIN_API_KEY` header:

```bash
# Get dashboard HTML
curl -H "ADMIN_API_KEY: your-key" http://localhost:3001/admin

# Get overview data as JSON
curl -H "ADMIN_API_KEY: your-key" http://localhost:3001/admin/api/overview

# Get recent runs with error context
curl -H "ADMIN_API_KEY: your-key" http://localhost:3001/admin/api/runs
```

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
