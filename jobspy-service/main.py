from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
import logging

from jobspy import scrape_jobs

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="JobSpy Scraper API", version="1.0.0")


class ScrapeRequest(BaseModel):
    search_term: str
    location: str = "USA"
    site_name: list[str] = ["indeed", "linkedin"]  # glassdoor/zip_recruiter disabled - broken upstream
    is_remote: Optional[bool] = None  # None = all jobs, True = remote only, False = on-site only
    job_type: Optional[str] = None  # fulltime, parttime, internship, contract (None = all)
    results_wanted: int = 50
    hours_old: Optional[int] = 72  # Jobs posted in last 72 hours
    country_indeed: Optional[str] = None  # Auto-detect from location if not provided


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


def detect_country(location: str) -> str:
    """Detect country from location string for Indeed/Glassdoor filtering."""
    location_lower = location.lower()

    # Check for Canadian indicators first (more specific)
    for indicator in CANADA_INDICATORS:
        if indicator in location_lower:
            return "Canada"

    # Check country mappings
    for key, value in COUNTRY_MAPPINGS.items():
        if key in location_lower:
            return value

    # Default to USA
    return "USA"


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
    return {"status": "ok", "service": "jobspy-scraper"}


@app.post("/scrape")
def scrape(request: ScrapeRequest):
    try:
        # Auto-detect country from location if not provided
        country = request.country_indeed or detect_country(request.location)
        remote_filter = f", remote={request.is_remote}" if request.is_remote is not None else ""
        job_type_filter = f", job_type={request.job_type}" if request.job_type else ""
        logger.info(f"Scraping jobs: {request.search_term} in {request.location} (country: {country}{remote_filter}{job_type_filter})")

        # Build kwargs - only include optional params if explicitly set
        scrape_kwargs = {
            "site_name": request.site_name,
            "search_term": request.search_term,
            "location": request.location,
            "results_wanted": request.results_wanted,
            "hours_old": request.hours_old,
            "country_indeed": country,
        }
        if request.is_remote is not None:
            scrape_kwargs["is_remote"] = request.is_remote
        if request.job_type is not None:
            scrape_kwargs["job_type"] = request.job_type

        jobs_df = scrape_jobs(**scrape_kwargs)

        if jobs_df is None or jobs_df.empty:
            logger.info("No jobs found")
            return {"jobs": [], "count": 0}

        # Convert DataFrame to list of dicts
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

        logger.info(f"Found {len(jobs)} jobs")
        return {"jobs": jobs, "count": len(jobs)}

    except Exception as e:
        logger.error(f"Scraping failed: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
