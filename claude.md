# AI Job Finder

AI-powered job aggregation and matching system that collects jobs from multiple sources, analyzes them against a user's resume using LLM, and returns match scores with detailed reasoning.

> **Note**: We use the free JobSpy scraper as the primary data source. All optimizations and solutions should target JobSpy first. SerpAPI is available but requires a paid API key.

## Quick Start

```bash
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
│   ├── matcher.ts        # LLM-based job matching (score 1-100)
│   └── query-expander.ts # LLM-based query expansion for wider search
├── llm/
│   └── client.ts         # OpenRouter client with structured outputs
├── api/
│   └── routes.ts         # Express routes with logging
├── db/
│   └── client.ts         # Prisma singleton
├── schemas/
│   └── llm-outputs.ts    # Zod schemas for LLM responses
└── utils/
    └── logger.ts         # Logging utility
```

## Key Concepts

### Services vs Agents
- **Services**: No LLM, deterministic (CollectorService, NormalizerService)
- **Agents**: Use LLM, require verification (MatcherAgent)

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

# Server
PORT=3001
LOG_LEVEL=info  # debug | info | warn | error (default: info)
```

## Data Sources

### JobSpy (Primary - Free)
- Scrapes Indeed, LinkedIn, Glassdoor, ZipRecruiter directly
- Requires separate Python microservice (see `jobspy-service/`)
- Set `JOBSPY_URL` env var (e.g., `http://localhost:8000`)
- Use `source: "jobspy"` in search requests
- Rate limited: max 2 concurrent requests via p-limit

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
- OpenRouter (LLM) - xiaomi/mimo-v2-flash:free
- JobSpy (Free scraper - primary)
- SerpAPI (Paid aggregator - optional)
- Zod (Validation)
- p-limit (Rate limiting for parallel requests)

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
