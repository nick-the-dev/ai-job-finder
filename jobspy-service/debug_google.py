"""
Google Jobs scraping with Playwright (headless browser)
Google Jobs requires JavaScript rendering - requests alone won't work
"""
import asyncio
import json
import re
from typing import Optional


async def scrape_google_jobs(
    query: str = "software engineer",
    location: str = "San Francisco",
    max_jobs: int = 20
) -> list[dict]:
    """Scrape Google Jobs using Playwright"""
    from playwright.async_api import async_playwright
    
    jobs = []
    
    async with async_playwright() as p:
        print("Launching browser...")
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            locale="en-US",
            viewport={"width": 1280, "height": 800}
        )
        page = await context.new_page()
        
        # Build search URL
        search_query = f"{query} jobs in {location}".replace(" ", "+")
        url = f"https://www.google.com/search?q={search_query}&ibp=htl;jobs"
        
        print(f"Navigating to: {url}")
        await page.goto(url, wait_until="networkidle")
        
        # Wait for job listings container
        try:
            await page.wait_for_selector('div[role="listitem"], li[data-ved]', timeout=10000)
            print("Job listings container found!")
        except Exception as e:
            print(f"Timeout waiting for jobs: {e}")
            await page.screenshot(path="/tmp/google_jobs_error.png")
            await browser.close()
            return []
        
        # Extra wait for dynamic content
        await page.wait_for_timeout(2000)
        
        # Take screenshot for debugging
        await page.screenshot(path="/tmp/google_jobs.png")
        print("Screenshot saved to /tmp/google_jobs.png")
        
        # Method 1: Try to extract from visible elements
        job_cards = await page.query_selector_all('li[data-ved]')
        print(f"Found {len(job_cards)} job cards (li[data-ved])")
        
        if not job_cards:
            # Method 2: Try different selector
            job_cards = await page.query_selector_all('div[jsname="VfAdnc"]')
            print(f"Found {len(job_cards)} job cards (div[jsname])")
        
        for i, card in enumerate(job_cards[:max_jobs]):
            try:
                job = await extract_job_from_card(card)
                if job and job.get("title"):
                    jobs.append(job)
                    print(f"  [{i+1}] {job.get('title', 'N/A')} @ {job.get('company', 'N/A')}")
            except Exception as e:
                print(f"  Error extracting job {i}: {e}")
        
        # Method 3: Extract from page's embedded JSON data
        if not jobs:
            print("\nTrying to extract from embedded JSON...")
            jobs = await extract_jobs_from_json(page)
        
        # Save HTML for analysis
        content = await page.content()
        with open("/tmp/google_jobs.html", "w") as f:
            f.write(content)
        print(f"Saved HTML ({len(content)} bytes) to /tmp/google_jobs.html")
        
        await browser.close()
    
    return jobs


async def extract_job_from_card(card) -> Optional[dict]:
    """Extract job details from a job card element"""
    job = {}
    
    # Try multiple selectors for title
    title_selectors = [
        'div[role="heading"]',
        'h2',
        'div.BjJfJf',
        '[class*="title"]'
    ]
    for sel in title_selectors:
        el = await card.query_selector(sel)
        if el:
            job["title"] = (await el.inner_text()).strip()
            break
    
    # Try to get company name
    company_selectors = [
        'div.vNEEBe',
        'div[class*="company"]',
        'span[class*="company"]'
    ]
    for sel in company_selectors:
        el = await card.query_selector(sel)
        if el:
            job["company"] = (await el.inner_text()).strip()
            break
    
    # Try to get location
    location_selectors = [
        'div.Qk80Jf',
        'div[class*="location"]',
        'span[class*="location"]'
    ]
    for sel in location_selectors:
        el = await card.query_selector(sel)
        if el:
            job["location"] = (await el.inner_text()).strip()
            break
    
    # Get all text as fallback parsing
    if not job.get("title"):
        all_text = await card.inner_text()
        lines = [l.strip() for l in all_text.split("\n") if l.strip()]
        if len(lines) >= 1:
            job["title"] = lines[0]
        if len(lines) >= 2:
            job["company"] = lines[1]
        if len(lines) >= 3:
            job["location"] = lines[2]
    
    return job if job.get("title") else None


async def extract_jobs_from_json(page) -> list[dict]:
    """Extract jobs from embedded JSON/script data in page"""
    jobs = []
    content = await page.content()
    
    # Pattern 1: Look for AF_initDataCallback with job data
    af_pattern = r'AF_initDataCallback\(\{[^}]*data:(\[[\s\S]*?\])\s*,\s*hash:'
    matches = re.findall(af_pattern, content)
    
    for match in matches:
        try:
            data = json.loads(match)
            jobs.extend(parse_google_job_data(data))
        except json.JSONDecodeError:
            continue
    
    # Pattern 2: Look for the specific job data marker
    job_data_pattern = r'520084652":\s*(\[[^\]]+\])'
    matches = re.findall(job_data_pattern, content)
    print(f"Found {len(matches)} job data blocks")
    
    return jobs


def parse_google_job_data(data: list, depth: int = 0) -> list[dict]:
    """Recursively parse Google's nested job data structure"""
    jobs = []
    
    if depth > 10:
        return jobs
    
    if isinstance(data, list):
        for item in data:
            if isinstance(item, list):
                jobs.extend(parse_google_job_data(item, depth + 1))
            elif isinstance(item, dict):
                # Check if this looks like a job object
                if any(k in str(item).lower() for k in ["title", "company", "location"]):
                    jobs.append(item)
    
    return jobs


async def main():
    print("=" * 60)
    print("Google Jobs Scraper Test")
    print("=" * 60)
    
    jobs = await scrape_google_jobs(
        query="senior software engineer",
        location="San Francisco, CA",
        max_jobs=10
    )
    
    print(f"\n{'=' * 60}")
    print(f"RESULTS: Found {len(jobs)} jobs")
    print("=" * 60)
    
    for i, job in enumerate(jobs, 1):
        print(f"\n[{i}] {job.get('title', 'N/A')}")
        print(f"    Company: {job.get('company', 'N/A')}")
        print(f"    Location: {job.get('location', 'N/A')}")
    
    return len(jobs) > 0


if __name__ == "__main__":
    success = asyncio.run(main())
    print(f"\n{'SUCCESS' if success else 'NEEDS MORE WORK'}")
