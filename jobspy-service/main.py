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
    site_name: list[str] = ["indeed", "linkedin", "glassdoor", "zip_recruiter"]
    is_remote: bool = False
    results_wanted: int = 50
    hours_old: Optional[int] = 72  # Jobs posted in last 72 hours
    country_indeed: str = "USA"


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
        logger.info(f"Scraping jobs: {request.search_term} in {request.location}")

        jobs_df = scrape_jobs(
            site_name=request.site_name,
            search_term=request.search_term,
            location=request.location,
            is_remote=request.is_remote,
            results_wanted=request.results_wanted,
            hours_old=request.hours_old,
            country_indeed=request.country_indeed,
        )

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
