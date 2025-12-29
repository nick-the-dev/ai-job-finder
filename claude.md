# AI Job Finder

AI-powered job aggregation and matching system that collects jobs from multiple sources, analyzes them against a user's resume using LLM, and returns match scores with detailed reasoning.

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
# Basic search
curl -X POST http://localhost:3001/search \
  -H "Content-Type: application/json" \
  -d '{
    "jobTitles": ["Senior Software Engineer"],
    "location": "United States",
    "isRemote": true,
    "resumeText": "Your resume text here...",
    "limit": 100
  }'

# Collect 1000 jobs, match top 10 (fast test)
curl -X POST http://localhost:3001/search \
  -H "Content-Type: application/json" \
  -d '{
    "jobTitles": ["Software Engineer", "Backend Developer", "Python Developer"],
    "location": "United States",
    "isRemote": true,
    "limit": 1000,
    "matchLimit": 10,
    "resumeText": "Your resume..."
  }'

# Force fresh fetch (skip cache)
curl -X POST http://localhost:3001/search \
  -H "Content-Type: application/json" \
  -d '{
    "jobTitles": ["Backend Developer"],
    "skipCache": true,
    "limit": 50,
    "resumeText": "..."
  }'

# Wider search (LLM expands job titles + suggests based on resume)
curl -X POST http://localhost:3001/search \
  -H "Content-Type: application/json" \
  -d '{
    "jobTitles": ["Backend Engineer"],
    "widerSearch": true,
    "limit": 500,
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
│   ├── collector.ts      # SerpAPI job collection
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
DATABASE_URL=postgresql://user:pass@localhost:5433/jobfinder
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=xiaomi/mimo-v2-flash:free
SERPAPI_API_KEY=...
PORT=3001
```

## Data Sources

### SerpAPI Google Jobs (Primary - Paid)
- Aggregates jobs from LinkedIn, Indeed, Glassdoor, etc.
- Uses pagination with `next_page_token`
- ~10 jobs per page, up to 100 pages

### JobSpy (Secondary - Free)
- Scrapes Indeed, LinkedIn, Glassdoor, ZipRecruiter
- Requires separate Python microservice
- Set `JOBSPY_URL` to enable

## Query Caching

To optimize API costs, queries are cached for 6 hours by default:
- Cache key = hash(query + location + isRemote + source)
- Cached results are stored in PostgreSQL
- Use `skipCache: true` to force fresh fetch
- Use `cacheHours: N` to customize TTL

## Wider Search (Query Expansion)

Use `widerSearch: true` to automatically expand job titles using LLM:

```
Input:  ["Backend Engineer"]
Output:
  fromExpansion: ["Backend Engineer", "Backend Developer", "Server-Side Engineer", "Software Engineer", "API Engineer"]
  fromResume:    ["Senior Backend Engineer", "Lead Backend Engineer", "Python Backend Engineer", ...]
  total: ~15 unique titles searched
```

**How it works:**
- **fromExpansion**: Role synonyms only (no tech-specific titles unless in original query)
- **fromResume**: LLM analyzes resume and suggests titles based on skills/experience level
- Results are cached to avoid repeated LLM calls
- Response includes `expansion` object showing all searched titles

## Tech Stack
- TypeScript, Node.js, Express
- PostgreSQL + Prisma ORM
- OpenRouter (LLM) - xiaomi/mimo-v2-flash:free
- SerpAPI (Paid job aggregator)
- JobSpy (Free scraper - optional)
- Zod (Validation)
