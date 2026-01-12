"""
Alternative: Use SerpAPI for reliable Google Jobs scraping
Get free API key at: https://serpapi.com (100 free searches/month)

Or use ScraperAPI, Oxylabs, or similar services
"""
import os
import httpx
from typing import Optional


async def scrape_google_jobs_serpapi(
    query: str,
    location: str = "United States",
    max_results: int = 20
) -> list[dict]:
    """Use SerpAPI for reliable Google Jobs data"""
    
    api_key = os.getenv("SERPAPI_KEY")
    if not api_key:
        print("SERPAPI_KEY not set. Get one at https://serpapi.com")
        return []
    
    params = {
        "engine": "google_jobs",
        "q": query,
        "location": location,
        "api_key": api_key,
    }
    
    async with httpx.AsyncClient() as client:
        resp = await client.get("https://serpapi.com/search", params=params)
        data = resp.json()
    
    jobs = []
    for item in data.get("jobs_results", [])[:max_results]:
        jobs.append({
            "title": item.get("title"),
            "company": item.get("company_name"),
            "location": item.get("location"),
            "description": item.get("description"),
            "posted": item.get("detected_extensions", {}).get("posted_at"),
            "salary": item.get("detected_extensions", {}).get("salary"),
            "job_id": item.get("job_id"),
            "link": item.get("share_link") or item.get("related_links", [{}])[0].get("link"),
        })
    
    return jobs


def get_google_jobs_via_rss(query: str) -> list[dict]:
    """
    Alternative: Google Jobs RSS feed (limited but no API needed)
    Note: This may not always work
    """
    import feedparser
    
    url = f"https://www.google.com/alerts/feeds/{query}/jobs"
    feed = feedparser.parse(url)
    
    return [
        {"title": e.title, "link": e.link, "summary": e.summary}
        for e in feed.entries
    ]
