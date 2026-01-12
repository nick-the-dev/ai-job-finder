# Google Jobs Scraping with Camoufox - Implementation Guide

## Overview

This document describes how to scrape Google Jobs using Camoufox (stealthy Firefox browser) with DataImpulse residential proxies. This approach bypasses Google's bot detection and extracts job listings with ALL apply URLs from multiple sources.

## Current Implementation

The scraper is implemented in `/jobspy-service/google_scraper.py` and exposed via the `/scrape-google` endpoint.

### Key Features
- Uses Camoufox (stealthy Firefox) to avoid bot detection
- DataImpulse residential proxy with automatic IP rotation
- Extracts ALL apply URLs per job (LinkedIn, Indeed, Glassdoor, company sites, etc.)
- Scroll pagination to load more jobs
- Only returns jobs that have apply URLs
- English-only results via `hl=en` parameter

### API Endpoint

```bash
curl -X POST "https://jobspy.49-12-207-132.sslip.io/scrape-google" \
  -H "Content-Type: application/json" \
  -d '{"search_term":"software engineer","location":"Toronto","results_wanted":20}'
```

**Response:**
```json
{
  "jobs": [
    {
      "title": "Principal Associate, Software Engineer",
      "company": "Capital One",
      "location": "Toronto, ON, Canada via Capital One",
      "description": null,
      "apply_urls": [
        {"url": "https://glassdoor.ca/...", "source": "Glassdoor"},
        {"url": "https://indeed.com/...", "source": "Indeed"},
        {"url": "https://linkedin.com/...", "source": "LinkedIn"}
      ],
      "search_query": "software engineer",
      "source": "google_jobs"
    }
  ],
  "count": 50
}
```

## Key Components

### 1. DataImpulse Proxy Configuration

```python
class DataImpulseProxy:
    def get_proxy_config(self) -> dict:
        session_id = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
        # Use US-only proxy for consistent English results
        username = f"{self.login}__cr.us__sid.{session_id}"
        
        return {
            'server': 'http://gw.dataimpulse.com:823',
            'username': username,
            'password': self.password,
        }
```

**Key points:**
- Session ID rotation (`__sid.{random}`) gives new IP per request
- Country targeting: `__cr.us` for US IPs (English results)
- Set `DATAIMPULSE_LOGIN` and `DATAIMPULSE_PASSWORD` env vars
- ~$1/GB pricing

### 2. Google Jobs URL Structure

```
https://www.google.com/search?q={query}&ibp=htl;jobs&sa=X&hl=en
```

The `hl=en` parameter forces English regardless of proxy location.

### 3. URL Extraction

Apply URLs are embedded in the HTML:

```python
url_pattern = r'\["(https://[^"]+google_jobs_apply[^"]+)","?([^",]*)","([^"]+)"'

# URLs appear in groups, one group per job
# Gap > 1000 chars between matches = new job
```

**Important:** Jobs and URL groups are matched by index. We only return jobs that have a matching URL group with actual URLs.

### 4. Retry Logic with Exponential Backoff

```python
for attempt in range(max_retries):
    try:
        jobs = await self._scrape_with_proxy(query, location, max_jobs)
        if jobs:
            return jobs
    except Exception as e:
        logger.warning(f"Attempt {attempt + 1}: Error - {e}")
    
    # Exponential backoff with jitter
    delay = (2 ** attempt) + random.uniform(1, 3)
    await asyncio.sleep(delay)
```

## Performance Results

From testing:
- **~50 jobs per query** with scroll pagination
- **6-10 jobs with URLs** per query (Google lazy-loads URLs)
- **3-7 apply URLs per job** from different sources
- **~10% retry rate** due to occasional blocks

## Integration with Main App

### Telegram Subscription Flow (Step 10/10)
Users can opt-in to Google Jobs during subscription setup. When enabled:
1. Normal JobSpy collection runs first
2. Google Jobs collection runs for each query
3. Results are merged and deduplicated

### Collector Integration

```typescript
// In collector.ts
async fetchFromGoogleJobs(query: string, location: string): Promise<RawJob[]> {
  const response = await fetch(`${JOBSPY_URL}/scrape-google`, {
    method: 'POST',
    body: JSON.stringify({ search_term: query, location, results_wanted: 50 })
  });
  return this.transformGoogleJobs(await response.json());
}
```

## Environment Variables

```bash
# Required for Google Jobs scraping
DATAIMPULSE_LOGIN=your_login_here
DATAIMPULSE_PASSWORD=your_password_here
```

## Limitations

1. **~10-20% of jobs have URLs** - Google lazy-loads apply URLs, not all are in initial HTML
2. **No job descriptions** - Would need to click each job for full details
3. **Proxy costs** - Residential proxies required (~$0.01-0.02 per search)
4. **Rate limits** - Too many requests = blocks, mitigated by session rotation
