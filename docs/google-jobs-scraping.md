# Google Jobs Scraping with Camoufox - Implementation Guide

## Overview

This document describes how to scrape Google Jobs using Camoufox (stealthy Firefox browser) with DataImpulse residential proxies. The scraper uses a **click-based extraction approach** that loads job details dynamically and extracts full information including descriptions and multiple apply URLs.

## Current Implementation

The scraper is implemented in `/jobspy-service/google_scraper.py` and exposed via the `/scrape-google` endpoint.

### Key Features
- Uses Camoufox (stealthy Firefox) to avoid bot detection
- DataImpulse residential proxy with automatic IP rotation per query
- **Click-based extraction**: clicks each job to load full details
- **Mouse wheel scrolling**: loads jobs dynamically (not scrollTop/arrow keys)
- Extracts ALL apply URLs per job (LinkedIn, Indeed, Glassdoor, company sites, etc.)
- Full job descriptions (up to 3000 chars)
- Salary and job type extraction
- **Parallel scrapers**: each job title runs in its own scraper instance with fresh proxy

### API Endpoint

```bash
curl -X POST "https://jobspy.49-12-207-132.sslip.io/scrape-google" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "search_term": "software engineer",
    "location": "Remote",
    "max_jobs": 50,
    "date_posted": "week"
  }'
```

**Response:**
```json
{
  "jobs": [
    {
      "title": "Senior Software Engineer, Backend",
      "company": "DraftKings",
      "location": "Canada",
      "description": "At DraftKings, AI is becoming an integral part of both our present and future...",
      "apply_urls": [
        {"url": "https://careers.draftkings.com/...", "source": "Careers"},
        {"url": "https://linkedin.com/...", "source": "LinkedIn"},
        {"url": "https://indeed.com/...", "source": "Indeed"}
      ],
      "search_query": "software engineer",
      "source": "google_jobs"
    }
  ],
  "count": 50
}
```

## How Click-Based Extraction Works

### Why Click-Based?

The old regex-based approach failed because:
1. **scrollTop/arrow keys don't load more jobs** - Google requires mouse wheel scrolling
2. **Regex URL matching is fragile** - position gaps between URL groups are unreliable
3. **Job details aren't in static HTML** - must click each job to load the right panel

### The New Approach

```
1. Navigate to Google Jobs search URL
2. Handle EU consent dialog if present
3. LOOP:
   a. Find job cards in left panel (position-based detection)
   b. Filter to only NEW cards (not clicked before)
   c. For each new card:
      - Click the card
      - Wait for right panel to load
      - Click "show full description" 
      - Extract: title, company, location, salary, job type, description
      - Extract all apply URLs from right panel
   d. Scroll with mouse wheel to load more jobs
   e. Repeat until no new jobs for 15-20 consecutive scrolls
```

### Position-Based Detection

CSS classes in Google Jobs are obfuscated and change frequently. Instead, we detect elements by position:

```javascript
// Job cards in left panel
if (rect.left > 0 && rect.left < 400 &&
    rect.width > 200 && rect.width < 500 &&
    rect.height > 60 && rect.height < 200 &&
    rect.top > 150 && rect.top < 700) {
  // This is likely a job card
}

// Title: fontSize >= 20, not "Job description"
// Company/Location: contains "•", fontSize 14
// Salary: contains "$"
// Apply URLs: links in right panel (x > 450)
```

## Key Components

### 1. DataImpulse Proxy Configuration

```python
class DataImpulseProxy:
    def get_proxy_config(self) -> dict:
        # Fresh session ID = fresh IP
        session_id = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
        username = f"{self.login}__cr.us__sid.{session_id}"
        
        return {
            'server': 'http://gw.dataimpulse.com:823',
            'username': username,
            'password': self.password,
        }
```

**Key points:**
- Session ID rotation (`__sid.{random}`) gives new IP per request
- Country targeting: `__cr.us` for US IPs (avoids EU consent dialogs)
- Each parallel scraper gets its own fresh IP automatically

### 2. Parallel Scraper Execution

When a subscription has multiple job titles, each title runs in its own scraper:

```typescript
// In search-subscriptions.ts
const googleJobPromises = sub.jobTitles.map((jobTitle, index) => {
  return new Promise(async (resolve) => {
    // Stagger start times to avoid detection
    if (index > 0) {
      await sleep(index * 2000); // 2s between scrapers
    }
    
    // Each call gets fresh proxy session automatically
    const jobs = await collector.fetchFromGoogleJobs(jobTitle, location);
    allRawJobs.push(...jobs);
    resolve();
  });
});

await Promise.all(googleJobPromises);
```

### 3. Extraction from Right Panel

After clicking a job card, extract details from the panel:

```javascript
// Title: first element with fontSize >= 20
for (const item of items) {
  if (item.fontSize >= 20 && item.text !== 'Job description') {
    title = item.text;
    break;
  }
}

// Company/Location: parse "Company • Location • via Source"
if (item.text.includes('•')) {
  const parts = item.text.split('•').map(p => p.trim());
  company = parts[0];
  location = parts[1]; // if not "via ..."
}

// Salary: contains "$" with pattern like "$143K–$185K a year"
if (item.text.includes('$')) {
  const match = item.text.match(/\$[\d,]+K?(?:\s*[–-]\s*\$[\d,]+K?)?\s*(?:a year)?/i);
  if (match) salary = match[0];
}

// Description: longest text after "Job description" header
```

## Performance Results

From production testing:
- **25-50 unique jobs per query** with click-based extraction
- **Full descriptions** (up to 3000 chars per job)
- **5-12 apply URLs per job** from different sources
- **~3 minutes** per query with 30+ jobs
- **Parallel execution**: 5 job titles complete in ~4 minutes (not 15)

## Integration with Main App

### Telegram Subscription Flow
Users can opt-in to Google Jobs during subscription setup (`useGoogleJobs: true`). When enabled:
1. Normal JobSpy collection runs first
2. Google Jobs scrapers run **in parallel** for each job title
3. Each scraper uses a different proxy IP
4. Results are merged and deduplicated

### Collector Integration

```typescript
// In collector.ts
async fetchFromGoogleJobs(
  query: string, 
  location: string,
  datePosted: string = 'month'
): Promise<RawJob[]> {
  const response = await axios.post(`${JOBSPY_URL}/scrape-google`, {
    search_term: query,
    location,
    max_jobs: 10000,
    date_posted: datePosted,
  }, { timeout: 600000 }); // 10 min timeout
  
  return response.data.jobs.map(job => this.transformGoogleJob(job));
}
```

## Environment Variables

```bash
# Required for Google Jobs scraping
DATAIMPULSE_LOGIN=your_login_here
DATAIMPULSE_PASSWORD=your_password_here

# JobSpy service URL
JOBSPY_URL=https://jobspy.49-12-207-132.sslip.io
```

## Troubleshooting

### Consent Dialog Issues
- EU proxies hit consent.google.com and block
- Solution: Use `__cr.us` (US proxies) to avoid consent dialogs

### Jobs Not Loading
- Arrow keys navigate between jobs, don't load more
- scrollTop on container doesn't work
- Solution: Use mouse wheel scrolling via `page.mouse.wheel(0, 300)`

### Missing Details
- Details only load after clicking the job card
- Must wait for right panel to render (~1s)
- "Show full description" must be clicked for full text

### Rate Limiting / Blocks
- "Unusual traffic" message = blocked
- Solution: Fresh proxy session + exponential backoff
- Each retry gets a new IP automatically
