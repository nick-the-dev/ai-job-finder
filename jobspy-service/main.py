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

            # LinkedIn: omit location for truly global search
            # Note: Passing "Worldwide" doesn't work - JobSpy maps it to US geoId
            # Omitting location lets LinkedIn search globally by default
            if "linkedin" in request.site_name:
                linkedin_kwargs = {
                    "site_name": ["linkedin"],
                    "search_term": request.search_term,
                    "results_wanted": request.results_wanted,
                    "hours_old": request.hours_old,
                    # No location = global search
                }
                if request.is_remote is not None:
                    linkedin_kwargs["is_remote"] = request.is_remote
                if request.job_type is not None:
                    linkedin_kwargs["job_type"] = request.job_type

                logger.info(f"  LinkedIn: location=<none> (global search)")
                linkedin_df = scrape_jobs(**linkedin_kwargs)
                linkedin_jobs = df_to_jobs(linkedin_df)
                logger.info(f"  LinkedIn: found {len(linkedin_jobs)} jobs")
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
