from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
import logging
import importlib.metadata

from jobspy import scrape_jobs

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="JobSpy Scraper API", version="1.0.0")

# Get jobspy version for debugging
try:
    JOBSPY_VERSION = importlib.metadata.version("python-jobspy")
except:
    JOBSPY_VERSION = "unknown"

logger.info(f"JobSpy version: {JOBSPY_VERSION}")


class ScrapeRequest(BaseModel):
    search_term: str
    location: Optional[str] = None  # None = global search (LinkedIn searches globally)
    site_name: list[str] = ["indeed", "linkedin"]  # glassdoor/zip_recruiter disabled - broken upstream
    is_remote: Optional[bool] = None  # None = all jobs, True = remote only, False = on-site only
    job_type: Optional[str] = None  # fulltime, parttime, internship, contract (None = all)
    results_wanted: int = 50
    hours_old: Optional[int] = 72  # Jobs posted in last 72 hours
    country_indeed: Optional[str] = None  # Auto-detect from location if provided, None for global


# Country detection from location string
COUNTRY_MAPPINGS = {
    "canada": "Canada",
    "usa": "USA",
    "united states": "USA",
    "uk": "UK",
    "united kingdom": "UK",
    "australia": "Australia",
    "germany": "Germany",
    "france": "France",
    "india": "India",
    "brazil": "Brazil",
    "mexico": "Mexico",
    "singapore": "Singapore",
}

# Canadian provinces/cities for detection
CANADA_INDICATORS = [
    "toronto", "vancouver", "montreal", "calgary", "ottawa", "edmonton",
    "winnipeg", "quebec", "hamilton", "kitchener", "london, on", "victoria",
    "halifax", "saskatoon", "regina", "st. john", "ontario", "british columbia",
    "alberta", "quebec", "manitoba", "saskatchewan", "nova scotia", ", on,", ", bc,",
    ", ab,", ", qc,", ", mb,", ", sk,", ", ns,", ", nb,", ", nl,", ", pe,", ", nt,",
    ", yt,", ", nu,", "on, canada", "bc, canada", "ab, canada", "canada"
]


def detect_country(location: str) -> Optional[str]:
    """Detect country from location string for Indeed/Glassdoor filtering.
    Returns None if country cannot be detected (no default).
    """
    location_lower = location.lower()

    # Check for Canadian indicators first (more specific)
    for indicator in CANADA_INDICATORS:
        if indicator in location_lower:
            return "Canada"

    # Check country mappings
    for key, value in COUNTRY_MAPPINGS.items():
        if key in location_lower:
            return value

    # No default - return None if country not detected
    return None


class JobResult(BaseModel):
    id: Optional[str] = None
    title: str
    company: str
    description: Optional[str] = None
    location: Optional[str] = None
    is_remote: bool = False
    min_amount: Optional[float] = None
    max_amount: Optional[float] = None
    currency: Optional[str] = None
    job_url: Optional[str] = None
    date_posted: Optional[str] = None
    site: Optional[str] = None


@app.get("/health")
def health():
    return {"status": "ok", "service": "jobspy-scraper", "jobspy_version": JOBSPY_VERSION}


@app.get("/debug/info")
def debug_info():
    """Return debug info about the server environment."""
    import socket
    import sys
    import platform
    import requests as req

    try:
        # Get external IP
        external_ip = req.get("https://api.ipify.org", timeout=5).text
    except:
        external_ip = "unknown"

    try:
        # Get IP info
        ip_info = req.get(f"https://ipinfo.io/{external_ip}/json", timeout=5).json()
    except:
        ip_info = {}

    # Get library versions
    lib_versions = {}
    for lib in ["requests", "urllib3", "tls_client", "pandas", "numpy"]:
        try:
            lib_versions[lib] = importlib.metadata.version(lib)
        except:
            lib_versions[lib] = "not installed"

    return {
        "jobspy_version": JOBSPY_VERSION,
        "python_version": sys.version,
        "platform": platform.platform(),
        "hostname": socket.gethostname(),
        "external_ip": external_ip,
        "ip_city": ip_info.get("city", "unknown"),
        "ip_country": ip_info.get("country", "unknown"),
        "lib_versions": lib_versions,
    }


@app.get("/debug/test-linkedin")
def debug_test_linkedin():
    """Test LinkedIn scraping with detailed debug info."""
    from collections import Counter

    linkedin_kwargs = {
        "site_name": ["linkedin"],
        "search_term": "Full stack engineer",
        "results_wanted": 30,
        # No location = should be global
    }

    logger.info(f"DEBUG: Testing LinkedIn with kwargs: {linkedin_kwargs}")
    df = scrape_jobs(**linkedin_kwargs)
    jobs = df_to_jobs(df)

    locations = [j.get("location") or "null" for j in jobs]
    loc_counts = Counter(locations).most_common(20)

    # Extract countries from locations
    countries = []
    for loc in locations:
        if loc and loc != "null":
            parts = loc.split(",")
            if len(parts) >= 2:
                countries.append(parts[-1].strip())
            else:
                countries.append(loc)
        else:
            countries.append("Unknown")
    country_counts = Counter(countries).most_common(10)

    return {
        "jobspy_version": JOBSPY_VERSION,
        "jobs_found": len(jobs),
        "location_distribution": loc_counts,
        "country_distribution": country_counts,
        "sample_jobs": [{"title": j["title"], "company": j["company"], "location": j["location"]} for j in jobs[:5]],
    }


@app.get("/debug/raw-linkedin")
def debug_raw_linkedin(lang: str = "en-US"):
    """Make a raw request to LinkedIn API to test geolocation."""
    import requests as req

    # Same headers that python-jobspy uses, but with configurable accept-language
    headers = {
        "authority": "www.linkedin.com",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "accept-language": f"{lang},en;q=0.9",
        "cache-control": "max-age=0",
        "upgrade-insecure-requests": "1",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    }

    # Build the same URL that python-jobspy builds for global search
    url = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
    params = {
        "keywords": "Full stack engineer",
        "pageNum": 0,
        "start": 0,
    }

    try:
        response = req.get(url, params=params, headers=headers, timeout=15)
        html = response.text[:2000]  # First 2000 chars for debugging

        # Try to extract some location info from the response
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(response.text, "html.parser")
        job_cards = soup.find_all("div", class_="base-search-card")

        locations = []
        for card in job_cards[:10]:
            loc_tag = card.find("span", class_="job-search-card__location")
            if loc_tag:
                locations.append(loc_tag.get_text(strip=True))

        return {
            "status_code": response.status_code,
            "jobs_in_response": len(job_cards),
            "sample_locations": locations,
            "request_url": response.request.url,
            "response_headers": dict(response.headers),
        }
    except Exception as e:
        return {"error": str(e)}


@app.get("/debug/jobspy-session")
def debug_jobspy_session():
    """Test using python-jobspy's actual session mechanism."""
    from bs4 import BeautifulSoup
    from jobspy.util import create_session
    from jobspy.linkedin.constant import headers

    # Create session the same way python-jobspy does
    session = create_session(
        proxies=None,
        ca_cert=None,
        is_tls=False,
        has_retry=True,
        delay=5,
        clear_cookies=True,
    )
    session.headers.update(headers)

    url = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
    params = {
        "keywords": "Full stack engineer",
        "pageNum": 0,
        "start": 0,
    }

    try:
        response = session.get(url, params=params, timeout=10)
        soup = BeautifulSoup(response.text, "html.parser")
        job_cards = soup.find_all("div", class_="base-search-card")

        locations = []
        for card in job_cards[:10]:
            loc_tag = card.find("span", class_="job-search-card__location")
            if loc_tag:
                locations.append(loc_tag.get_text(strip=True))

        return {
            "status_code": response.status_code,
            "jobs_in_response": len(job_cards),
            "sample_locations": locations,
            "request_url": str(response.request.url) if hasattr(response, 'request') else response.url,
            "session_type": type(session).__name__,
            "session_headers": dict(session.headers),
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "traceback": traceback.format_exc()}


@app.get("/debug/linkedin-with-cookie")
def debug_linkedin_with_cookie(lang: str = "en-GB", geo: str = ""):
    """Test LinkedIn with different cookies to see if geolocation changes.

    LinkedIn may set user preferences via cookies. Test with:
    - lang=en-GB (British English)
    - lang=de-DE (German)
    - geo=DE (Germany geoId)
    """
    import requests as req
    from bs4 import BeautifulSoup

    headers = {
        "authority": "www.linkedin.com",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": f"{lang},en;q=0.9",
        "cache-control": "no-cache",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    }

    # Try setting language cookie
    cookies = {
        "lang": f"v=2&lang={lang.lower().replace('-', '_')}",
    }

    url = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
    params = {
        "keywords": "Full stack engineer",
        "pageNum": 0,
        "start": 0,
    }

    # If geo specified, add geoId parameter (LinkedIn geographic filter)
    if geo:
        params["geoId"] = geo

    try:
        response = req.get(url, params=params, headers=headers, cookies=cookies, timeout=15)
        soup = BeautifulSoup(response.text, "html.parser")
        job_cards = soup.find_all("div", class_="base-search-card")

        locations = []
        for card in job_cards[:10]:
            loc_tag = card.find("span", class_="job-search-card__location")
            if loc_tag:
                locations.append(loc_tag.get_text(strip=True))

        # Check response cookies
        resp_cookies = dict(response.cookies)

        return {
            "status_code": response.status_code,
            "jobs_in_response": len(job_cards),
            "sample_locations": locations,
            "request_url": response.request.url,
            "cookies_sent": cookies,
            "cookies_received": resp_cookies,
            "lang_param": lang,
            "geo_param": geo or "none",
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "traceback": traceback.format_exc()}


def df_to_jobs(jobs_df) -> list:
    """Convert DataFrame to list of job dicts."""
    if jobs_df is None or jobs_df.empty:
        return []
    jobs = []
    for _, row in jobs_df.iterrows():
        job = {
            "id": str(row.get("id", "")),
            "title": str(row.get("title", "Unknown")),
            "company": str(row.get("company", "Unknown")),
            "description": str(row.get("description", "")) if row.get("description") else None,
            "location": str(row.get("location", "")) if row.get("location") else None,
            "is_remote": bool(row.get("is_remote", False)),
            "min_amount": float(row["min_amount"]) if row.get("min_amount") and str(row["min_amount"]) != "nan" else None,
            "max_amount": float(row["max_amount"]) if row.get("max_amount") and str(row["max_amount"]) != "nan" else None,
            "currency": str(row.get("currency", "")) if row.get("currency") else None,
            "job_url": str(row.get("job_url", "")) if row.get("job_url") else None,
            "date_posted": str(row.get("date_posted", "")) if row.get("date_posted") else None,
            "site": str(row.get("site", "")) if row.get("site") else None,
        }
        jobs.append(job)
    return jobs


# LinkedIn geoId for worldwide search
LINKEDIN_WORLDWIDE_GEOID = "92000000"


def scrape_linkedin_worldwide(search_term: str, results_wanted: int = 50, hours_old: Optional[int] = None) -> list:
    """Custom LinkedIn scraper that uses geoId for truly worldwide results.

    python-jobspy doesn't support geoId parameter, so LinkedIn defaults to US results
    when no location is specified. This function directly calls LinkedIn's API with
    geoId=92000000 (Worldwide) to get global job listings.
    """
    import requests
    from bs4 import BeautifulSoup
    import time
    import random
    from datetime import datetime

    headers = {
        "authority": "www.linkedin.com",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    }

    base_url = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
    jobs = []
    seen_ids = set()
    start = 0
    page = 0
    max_pages = (results_wanted // 25) + 2  # LinkedIn returns ~25 jobs per page

    while len(jobs) < results_wanted and page < max_pages:
        params = {
            "keywords": search_term,
            "geoId": LINKEDIN_WORLDWIDE_GEOID,  # Key: Worldwide geoId
            "pageNum": 0,
            "start": start,
        }

        # Add time filter if specified
        if hours_old:
            params["f_TPR"] = f"r{hours_old * 3600}"

        try:
            logger.info(f"  LinkedIn worldwide: fetching page {page + 1}, start={start}")
            response = requests.get(base_url, params=params, headers=headers, timeout=15)

            if response.status_code == 429:
                logger.warning("  LinkedIn: Rate limited (429), stopping")
                break
            if response.status_code != 200:
                logger.error(f"  LinkedIn: Error {response.status_code}")
                break

            soup = BeautifulSoup(response.text, "html.parser")
            job_cards = soup.find_all("div", class_="base-search-card")

            if not job_cards:
                logger.info("  LinkedIn: No more jobs found")
                break

            for card in job_cards:
                if len(jobs) >= results_wanted:
                    break

                # Extract job ID from URL
                href_tag = card.find("a", class_="base-card__full-link")
                if not href_tag or "href" not in href_tag.attrs:
                    continue

                href = href_tag.attrs["href"].split("?")[0]
                job_id = href.split("-")[-1]

                if job_id in seen_ids:
                    continue
                seen_ids.add(job_id)

                # Extract job details
                title_tag = card.find("span", class_="sr-only")
                title = title_tag.get_text(strip=True) if title_tag else "Unknown"

                company_tag = card.find("h4", class_="base-search-card__subtitle")
                company_a_tag = company_tag.find("a") if company_tag else None
                company = company_a_tag.get_text(strip=True) if company_a_tag else "Unknown"

                loc_tag = card.find("span", class_="job-search-card__location")
                location = loc_tag.get_text(strip=True) if loc_tag else None

                # Parse date
                datetime_tag = card.find("time", class_="job-search-card__listdate")
                date_posted = None
                if datetime_tag and "datetime" in datetime_tag.attrs:
                    try:
                        date_posted = datetime_tag["datetime"]
                    except:
                        pass

                # Check if remote (simple heuristic)
                is_remote = "remote" in (title or "").lower() or "remote" in (location or "").lower()

                job = {
                    "id": f"li-{job_id}",
                    "title": title,
                    "company": company,
                    "description": None,  # Would need separate request
                    "location": location,
                    "is_remote": is_remote,
                    "min_amount": None,
                    "max_amount": None,
                    "currency": None,
                    "job_url": f"https://www.linkedin.com/jobs/view/{job_id}",
                    "date_posted": date_posted,
                    "site": "linkedin",
                }
                jobs.append(job)

            start += len(job_cards)
            page += 1

            # Rate limit protection
            if page < max_pages and len(jobs) < results_wanted:
                time.sleep(random.uniform(2, 4))

        except Exception as e:
            logger.error(f"  LinkedIn worldwide scrape error: {e}")
            break

    logger.info(f"  LinkedIn worldwide: collected {len(jobs)} jobs")
    return jobs


@app.post("/scrape")
def scrape(request: ScrapeRequest):
    try:
        remote_filter = f", remote={request.is_remote}" if request.is_remote is not None else ""
        job_type_filter = f", job_type={request.job_type}" if request.job_type else ""

        # Global search: no location provided
        # Need to handle LinkedIn and Indeed differently:
        # - LinkedIn: use location="Worldwide" for global results
        # - Indeed: use country_indeed="Canada" (no location) for Canadian jobs as default
        is_global_search = not request.location and not request.country_indeed

        if is_global_search:
            logger.info(f"Scraping jobs (GLOBAL): {request.search_term}{remote_filter}{job_type_filter}")
            all_jobs = []

            # LinkedIn: use custom worldwide scraper with geoId=92000000
            # python-jobspy doesn't support geoId, so LinkedIn defaults to US results
            # Our custom scraper explicitly sets geoId for truly global results
            if "linkedin" in request.site_name:
                logger.info(f"  LinkedIn: using worldwide scraper with geoId={LINKEDIN_WORLDWIDE_GEOID}")
                linkedin_jobs = scrape_linkedin_worldwide(
                    search_term=request.search_term,
                    results_wanted=request.results_wanted,
                    hours_old=request.hours_old,
                )

                # Debug: log location distribution
                from collections import Counter
                locations = [j.get("location", "null") for j in linkedin_jobs]
                loc_counts = Counter(locations).most_common(10)
                logger.info(f"  LinkedIn location distribution: {loc_counts}")

                all_jobs.extend(linkedin_jobs)

            # Indeed: use country_indeed="Canada" (no location)
            if "indeed" in request.site_name:
                indeed_kwargs = {
                    "site_name": ["indeed"],
                    "search_term": request.search_term,
                    "results_wanted": request.results_wanted,
                    "hours_old": request.hours_old,
                    "country_indeed": "Canada",
                }
                if request.is_remote is not None:
                    indeed_kwargs["is_remote"] = request.is_remote
                if request.job_type is not None:
                    indeed_kwargs["job_type"] = request.job_type

                logger.info(f"  Indeed: country_indeed=Canada")
                indeed_df = scrape_jobs(**indeed_kwargs)
                indeed_jobs = df_to_jobs(indeed_df)
                logger.info(f"  Indeed: found {len(indeed_jobs)} jobs")
                all_jobs.extend(indeed_jobs)

            logger.info(f"Found {len(all_jobs)} jobs total (global search)")
            return {"jobs": all_jobs, "count": len(all_jobs)}

        # Non-global search: location provided
        # Auto-detect country from location if not explicitly provided
        country = None
        if request.country_indeed:
            country = request.country_indeed
        elif request.location:
            country = detect_country(request.location)

        location_str = request.location or "any"
        country_str = country or "auto"
        logger.info(f"Scraping jobs: {request.search_term} in {location_str} (country: {country_str}{remote_filter}{job_type_filter})")

        # Build kwargs - only include optional params if explicitly set
        scrape_kwargs = {
            "site_name": request.site_name,
            "search_term": request.search_term,
            "results_wanted": request.results_wanted,
            "hours_old": request.hours_old,
        }
        if request.location:
            scrape_kwargs["location"] = request.location
        if country:
            scrape_kwargs["country_indeed"] = country
        if request.is_remote is not None:
            scrape_kwargs["is_remote"] = request.is_remote
        if request.job_type is not None:
            scrape_kwargs["job_type"] = request.job_type

        jobs_df = scrape_jobs(**scrape_kwargs)
        jobs = df_to_jobs(jobs_df)

        logger.info(f"Found {len(jobs)} jobs")
        return {"jobs": jobs, "count": len(jobs)}

    except Exception as e:
        logger.error(f"Scraping failed: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
