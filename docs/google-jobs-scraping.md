# Google Jobs Scraping with Camoufox - Implementation Guide

## Overview

This document describes how to scrape Google Jobs using Camoufox (stealthy Firefox browser) with residential proxies. This approach bypasses Google's bot detection and extracts job listings with apply URLs.

## Key Components

### 1. Camoufox Browser

Camoufox is a stealthy Firefox fork designed to avoid bot detection. Unlike regular Playwright/Puppeteer, it:
- Randomizes browser fingerprints
- Mimics real user behavior
- Bypasses common anti-bot measures

**Installation:**
```bash
pip install camoufox[geoip]
python -m camoufox fetch  # Downloads browser binaries
```

**Basic Usage:**
```python
from camoufox.async_api import AsyncCamoufox

async with AsyncCamoufox(headless=True, proxy=proxy_config, geoip=True) as browser:
    context = await browser.new_context(ignore_https_errors=True)
    page = await context.new_page()
    await page.goto(url, wait_until='networkidle', timeout=60000)
```

### 2. Proxy Requirements

**Important:** Google blocks datacenter proxies. You MUST use residential proxies.

**Tested Working Proxies:**

#### DataImpulse (Recommended)
```python
import os

def get_dataimpulse_proxy():
    login = os.getenv("DATAIMPULSE_LOGIN")
    password = os.getenv("DATAIMPULSE_PASSWORD")
    session_id = ''.join(random.choices(string.ascii_lowercase, k=8))
    return {
        'server': 'http://gw.dataimpulse.com:823',
        'username': f'{login}__cr.us,ca__sid.{session_id}',
        'password': password,
    }
```

- Session ID rotation (`__sid.{random}`) gives new IP per request
- Country targeting: `__cr.us,ca` for US/Canada IPs
- ~$1/GB pricing
- Set `DATAIMPULSE_LOGIN` and `DATAIMPULSE_PASSWORD` env vars

**Blocked Proxies (Don't Use):**
- Datacenter proxies (the ones in JOBSPY_PROXIES env var)
- Most cheap proxy services
- VPNs

### 3. Google Jobs URL Structure

```
https://www.google.com/search?q={query}+{location}&ibp=htl;jobs&sa=X
```

Example:
```
https://www.google.com/search?q=software+engineer+Toronto&ibp=htl;jobs&sa=X
```

### 4. Page Loading Strategy

```python
# Wait for full page load - Google Jobs is JavaScript-heavy
await page.goto(url, wait_until='networkidle', timeout=60000)
await page.wait_for_timeout(5000)  # Extra wait for dynamic content

# Check for blocking
html = await page.content()
if 'unusual traffic' in html.lower():
    # Blocked - retry with new session/proxy
    pass

# Verify full load (should be 1MB+)
if len(html) < 100000:
    # Partial load - retry
    pass
```

### 5. Extracting Job Titles

Jobs are extracted from visible page text:

```python
body = await page.inner_text('body')
lines = [l.strip() for l in body.split('\n') if l.strip()]

job_titles = []
keywords = ['Engineer', 'Developer', 'Manager', 'Full Stack', 'Architect', 'Lead']

for i, line in enumerate(lines):
    if any(kw in line for kw in keywords) and 15 < len(line) < 100:
        if not any(x in line for x in ['http', '.com', 'Search', 'Filter']):
            company = lines[i+1].replace('•','').strip() if i+1 < len(lines) else ''
            job_titles.append({'title': line, 'company': company})
```

### 6. Extracting Apply URLs

Apply URLs are embedded in the HTML in a specific structure:

```python
# Pattern: ["url", "domain", "Source", ...]
url_pattern = r'\["(https://[^"]+google_jobs_apply[^"]+)","?([^",]*)","([^"]+)"'
all_urls = re.findall(url_pattern, html)

# Clean URLs (unescape)
for url, domain, source in all_urls:
    url = url.replace('\\u003d', '=').replace('\\u0026', '&')
    # url is the apply link, source is the job board name
```

**URL Sources Found:**
- Direct career pages (company.com/careers)
- LinkedIn
- Indeed
- Glassdoor
- ZipRecruiter
- Workopolis
- Built In
- Lever, Greenhouse, Workday (ATS platforms)
- Various aggregators (BeBee, Talent.com, etc.)

### 7. Matching URLs to Jobs

URLs appear in groups in the HTML, matching the job order:

```python
# Group URLs by finding gaps in HTML positions
url_groups = []
current_group = []
last_pos = 0

for match in re.finditer(url_pattern, html):
    pos = match.start()
    # Gap > 1000 chars = new job
    if last_pos > 0 and pos - last_pos > 1000:
        if current_group:
            url_groups.append(current_group)
        current_group = []
    
    url = match.group(1)  # Clean and add
    source = match.group(3)
    current_group.append({'url': url, 'source': source})
    last_pos = match.end()

if current_group:
    url_groups.append(current_group)

# Match to jobs (same order)
for i, job in enumerate(job_titles):
    job['apply_urls'] = url_groups[i] if i < len(url_groups) else []
```

### 8. Scroll Pagination

Google Jobs loads ~10 jobs initially. Scroll to load more:

```python
scroll_attempts = 0
max_scroll_attempts = 15
last_job_count = len(jobs)

while len(jobs) < max_jobs and scroll_attempts < max_scroll_attempts:
    scroll_attempts += 1
    
    await page.evaluate("""
        const containers = document.querySelectorAll('div[role="list"], ul');
        containers.forEach(c => c.scrollTop = c.scrollHeight);
        window.scrollTo(0, document.body.scrollHeight);
        const jobContainer = document.querySelector('.gws-plugins-horizon-jobs__tl-lvc');
        if (jobContainer) jobContainer.scrollTop = jobContainer.scrollHeight;
    """)
    
    await page.wait_for_timeout(1500)
    
    # Re-extract jobs
    new_jobs = await extract_jobs_from_page(page)
    
    # Check progress
    if len(new_jobs) == last_job_count:
        no_progress_count += 1
        if no_progress_count >= 3:
            break  # No more jobs loading
    else:
        last_job_count = len(new_jobs)
```

With scrolling, you can get ~50-60 jobs per query.

### 9. Retry Logic

Google occasionally blocks even residential proxies. Implement retries:

```python
async def scrape_with_retry(query, location, max_retries=5):
    for attempt in range(max_retries):
        proxy = get_dataimpulse_proxy()  # New session each attempt
        
        try:
            async with AsyncCamoufox(headless=True, proxy=proxy, geoip=True) as browser:
                # ... scraping logic ...
                
                if 'unusual traffic' in html.lower():
                    print(f'Attempt {attempt+1}: blocked, retrying...')
                    await asyncio.sleep(2)
                    continue
                
                return jobs
                
        except Exception as e:
            print(f'Attempt {attempt+1}: error - {e}')
            await asyncio.sleep(2)
    
    return []
```

### 10. Performance Results

From testing:
- **500+ unique jobs** collected in ~7.5 minutes
- **~50-60 jobs per query** with scroll pagination
- **6-8 apply URLs per job** from different sources
- **~30% retry rate** due to occasional blocks

### 11. Query Variations

To get more jobs, use multiple query variations:

```python
queries = [
    "full stack software engineer",
    "software engineer",
    "software developer",
    "frontend developer",
    "backend developer",
    "web developer",
    "react developer",
    "node.js developer",
    "python developer",
    "java developer",
    "senior software engineer",
    "devops engineer",
    "cloud engineer",
    "data engineer",
    # ... etc
]
```

## Complete Example

See `/jobspy-service/test_dataimpulse_500.py` for a working implementation that:
1. Uses DataImpulse proxy with session rotation
2. Searches multiple query variations
3. Implements scroll pagination
4. Handles retries on blocks
5. Deduplicates jobs
6. Saves to CSV/JSON

## Integration Notes

### For Main App Integration:

1. **Add as new source** alongside JobSpy/SerpAPI
2. **Use for Google Jobs only** - Indeed/LinkedIn have their own APIs via JobSpy
3. **Rate limiting** - Add delays between queries (2s recommended)
4. **Proxy costs** - DataImpulse charges per GB, estimate ~$0.01-0.02 per search
5. **Apply URL priority** - Prefer direct career pages > LinkedIn > Indeed > aggregators

### Environment Variables Needed:

```bash
# DataImpulse proxy credentials (get from DataImpulse dashboard)
DATAIMPULSE_LOGIN=your_login_here
DATAIMPULSE_PASSWORD=your_password_here
```

### Dependencies:

```
camoufox[geoip]>=0.4.11
```

Note: Camoufox requires downloading browser binaries (~300MB) on first run.

## Limitations

1. **No job descriptions** - Would need to click each job and parse detail panel
2. **No salary data** - Google sometimes shows salary, but not consistently
3. **No posted date** - Available in UI but harder to extract from HTML
4. **Proxy costs** - Residential proxies required, adds cost per search
5. **Rate limits** - Too many requests = blocks, need session rotation
