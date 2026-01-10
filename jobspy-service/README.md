# JobSpy Scraper Service

FastAPI microservice wrapping [JobSpy](https://github.com/speedyapply/JobSpy) for job scraping.

## Supported Job Sites

| Site | Status | Notes |
|------|--------|-------|
| Indeed | Working | Requires `country_indeed` parameter |
| LinkedIn | Working | May rate limit after ~10 pages without proxies |
| Glassdoor | Disabled | Broken upstream ([issue #279](https://github.com/speedyapply/JobSpy/issues/279)) |
| ZipRecruiter | Disabled | Unreliable |

## Quick Start

```bash
pip install -r requirements.txt
uvicorn main:app --port 8000
```

## Proxy Configuration

To avoid rate limiting and increase throughput, configure a proxy pool:

```bash
# Set comma-separated proxy URLs (format: http://user:pass@host:port)
export JOBSPY_PROXIES="http://user1:pass1@proxy1.com:8080,http://user2:pass2@proxy2.com:8080"
uvicorn main:app --port 8000
```

The service will automatically:
- Rotate proxies using round-robin for each request
- Mask credentials in logs for security
- Fall back to direct connection if no proxies are configured

Check proxy status:
```bash
curl http://localhost:8000/debug/proxies
# Returns: {"proxy_count": 2, "proxies_enabled": true}
```

## API

### POST /scrape

```json
{
  "search_term": "Software Engineer",
  "location": "Toronto, Canada",
  "site_name": ["indeed", "linkedin"],
  "is_remote": false,
  "results_wanted": 50,
  "hours_old": 72,
  "country_indeed": "Canada"
}
```

**Response:**
```json
{
  "jobs": [...],
  "count": 50
}
```

### GET /health

Returns `{"status": "ok", "service": "jobspy-scraper"}`

## Country Detection

The service auto-detects country from location string for Indeed/Glassdoor:
- Canadian cities/provinces -> `Canada`
- US indicators -> `USA`
- Default -> `USA`

## Supported Countries

Indeed & Glassdoor support: Argentina, Australia, Austria, Belgium, Brazil, Canada, France, Germany, Hong Kong, India, Ireland, Italy, Mexico, Netherlands, New Zealand, Singapore, Spain, Switzerland, UK, USA, Vietnam, and more.
