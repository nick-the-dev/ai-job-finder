"""
Test Google Jobs scraping with Camoufox
Camoufox is a stealthy Firefox fork that avoids bot detection
"""
import asyncio
import json
import re
from typing import Optional


async def scrape_google_jobs_camoufox(
    query: str = "software engineer",
    location: str = "San Francisco",
    max_jobs: int = 20
) -> list[dict]:
    """Scrape Google Jobs using Camoufox (stealthy Firefox)"""
    from camoufox.async_api import AsyncCamoufox
    
    jobs = []
    
    async with AsyncCamoufox(headless=True) as browser:
        print("Launched Camoufox browser...")
        page = await browser.new_page()
        
        # Build Google Jobs search URL - use the direct jobs URL format
        search_query = f"{query} {location}".replace(" ", "+")
        url = f"https://www.google.com/search?q={search_query}&ibp=htl;jobs&sa=X"
        
        print(f"Navigating to: {url}")
        await page.goto(url, wait_until="domcontentloaded")
        
        # Wait for page to stabilize
        await page.wait_for_timeout(3000)
        
        # Try to click on the Jobs tab if visible
        try:
            jobs_tab = await page.query_selector('a[href*="ibp=htl;jobs"], div[data-hveid]:has-text("Jobs")')
            if jobs_tab:
                print("Clicking Jobs tab...")
                await jobs_tab.click()
                await page.wait_for_timeout(3000)
        except Exception as e:
            print(f"No Jobs tab to click: {e}")
        
        # Wait for job listings - try multiple selectors
        job_selectors = [
            'div.gws-plugins-horizon-jobs__tl-lvc',  # Job list container
            'li.iFjolb',  # Individual job cards
            'div[jsname="yEVEwb"]',  # Job card wrapper
            'div[data-hveid] ul li',  # Generic list items
            'div.BjJfJf',  # Job title elements
        ]
        
        found_selector = None
        for selector in job_selectors:
            try:
                await page.wait_for_selector(selector, timeout=5000)
                found_selector = selector
                print(f"Found jobs with selector: {selector}")
                break
            except:
                continue
        
        if not found_selector:
            print("No job selector matched, trying to extract from page content...")
            await page.screenshot(path="/tmp/camoufox_google_error.png")
            print("Screenshot saved to /tmp/camoufox_google_error.png")
            
            # Try extracting from page content anyway
            content = await page.content()
            with open("/tmp/camoufox_google_error.html", "w") as f:
                f.write(content)
            print(f"HTML saved ({len(content)} bytes)")
            
            # Try to extract jobs from visible text
            jobs = await extract_jobs_from_page_text(page)
            if jobs:
                return jobs
            return []
        
        # Extra wait for dynamic content
        await page.wait_for_timeout(2000)
        
        # Take screenshot for debugging
        await page.screenshot(path="/tmp/camoufox_google_jobs.png")
        print("Screenshot saved to /tmp/camoufox_google_jobs.png")
        
        # Try different selectors for job cards
        selectors_to_try = [
            'li[data-ved]',
            'div[role="treeitem"]',
            'div[jsname="yEVEwb"]',
            'div.iFjolb',
            'div[data-hveid]'
        ]
        
        job_cards = []
        for selector in selectors_to_try:
            job_cards = await page.query_selector_all(selector)
            if job_cards:
                print(f"Found {len(job_cards)} job cards using selector: {selector}")
                break
        
        if not job_cards:
            print("No job cards found with any selector")
            content = await page.content()
            with open("/tmp/camoufox_google_jobs.html", "w") as f:
                f.write(content)
            print(f"HTML saved for analysis ({len(content)} bytes)")
            return []
        
        # Extract job data from cards
        for i, card in enumerate(job_cards[:max_jobs]):
            try:
                job = await extract_job_from_card(card)
                if job and job.get("title"):
                    jobs.append(job)
                    print(f"  [{i+1}] {job.get('title', 'N/A')} @ {job.get('company', 'N/A')}")
            except Exception as e:
                print(f"  Error extracting job {i}: {e}")
        
        # If no jobs extracted from cards, try JSON extraction
        if not jobs:
            print("\nTrying to extract from page JSON data...")
            content = await page.content()
            jobs = extract_jobs_from_html(content)
        
        # Save HTML for analysis
        content = await page.content()
        with open("/tmp/camoufox_google_jobs.html", "w") as f:
            f.write(content)
        print(f"HTML saved ({len(content)} bytes)")
    
    return jobs


async def extract_job_from_card(card) -> Optional[dict]:
    """Extract job details from a Google Jobs card element"""
    job = {}
    
    # Get all text from the card first
    all_text = await card.inner_text()
    lines = [l.strip() for l in all_text.split("\n") if l.strip()]
    
    # Google Jobs cards typically have this structure:
    # Line 0: Job title
    # Line 1: Company name
    # Line 2: Location
    # Line 3+: Other info (salary, posted time, etc.)
    
    if len(lines) >= 1:
        job["title"] = lines[0]
    if len(lines) >= 2:
        job["company"] = lines[1]
    if len(lines) >= 3:
        job["location"] = lines[2]
    
    # Try to find more specific elements
    title_selectors = ['div[role="heading"]', 'h2', 'h3', '.BjJfJf']
    for sel in title_selectors:
        el = await card.query_selector(sel)
        if el:
            text = (await el.inner_text()).strip()
            if text and len(text) > 3:
                job["title"] = text
                break
    
    # Look for company
    company_selectors = ['.vNEEBe', '.sMzDkb', 'div[class*="company"]']
    for sel in company_selectors:
        el = await card.query_selector(sel)
        if el:
            text = (await el.inner_text()).strip()
            if text:
                job["company"] = text
                break
    
    # Look for location
    location_selectors = ['.Qk80Jf', '.sMzDkb', 'div[class*="location"]']
    for sel in location_selectors:
        el = await card.query_selector(sel)
        if el:
            text = (await el.inner_text()).strip()
            if text and text != job.get("company"):
                job["location"] = text
                break
    
    return job if job.get("title") else None


async def extract_jobs_from_page_text(page) -> list[dict]:
    """Extract jobs by parsing visible text on the page"""
    jobs = []
    
    # Get all text from the page
    content = await page.content()
    
    # Look for job patterns in the page
    # Google Jobs often has structured data we can extract
    
    # Try to find job titles and companies from common patterns
    # Pattern: "Job Title at Company" or "Job Title - Company"
    import re
    
    # Look for AF_initDataCallback with job data
    af_pattern = r'data:function\(\)\{return\s*(\[[\s\S]*?\])\s*\}'
    matches = re.findall(af_pattern, content)
    
    for match in matches[:5]:
        try:
            # Try to parse as JSON
            data = json.loads(match)
            if isinstance(data, list):
                jobs.extend(parse_nested_job_data(data))
        except:
            continue
    
    # Also try simpler text extraction from visible elements
    try:
        # Get all visible text
        body_text = await page.inner_text('body')
        lines = [l.strip() for l in body_text.split('\n') if l.strip()]
        
        # Look for patterns like job listings
        i = 0
        while i < len(lines) - 2:
            line = lines[i]
            # Job titles often contain "Engineer", "Developer", "Manager", etc.
            if any(kw in line for kw in ['Engineer', 'Developer', 'Manager', 'Designer', 'Analyst', 'Scientist']):
                job = {
                    'title': line,
                    'company': lines[i + 1] if i + 1 < len(lines) else 'Unknown',
                    'location': lines[i + 2] if i + 2 < len(lines) else 'Unknown',
                }
                # Avoid duplicates
                if not any(j['title'] == job['title'] for j in jobs):
                    jobs.append(job)
                i += 3
            else:
                i += 1
    except Exception as e:
        print(f"Error extracting from visible text: {e}")
    
    return jobs[:20]


def parse_nested_job_data(data, depth=0) -> list[dict]:
    """Recursively parse nested JSON to find job data"""
    jobs = []
    if depth > 15:
        return jobs
    
    if isinstance(data, list):
        for item in data:
            if isinstance(item, list):
                jobs.extend(parse_nested_job_data(item, depth + 1))
            elif isinstance(item, str):
                # Check if it looks like a job title
                if any(kw in item for kw in ['Engineer', 'Developer', 'Manager', 'Designer']):
                    jobs.append({'title': item, 'source': 'nested_json'})
    
    return jobs



    """Extract jobs from embedded JSON in the page"""
    jobs = []
    
    # Google embeds job data in script tags with specific patterns
    # Pattern for AF_initDataCallback
    af_pattern = r'AF_initDataCallback\([^)]*"key":"[^"]*jobs[^"]*"[^)]*data:(\[[\s\S]*?\])\s*\}'
    
    # Simpler pattern to find job-like structures
    job_patterns = [
        r'"title":"([^"]+)"[^}]*"companyName":"([^"]+)"[^}]*"location":"([^"]+)"',
        r'"job_title":"([^"]+)"[^}]*"company":"([^"]+)"[^}]*"location":"([^"]+)"',
    ]
    
    for pattern in job_patterns:
        matches = re.findall(pattern, html)
        for match in matches[:20]:
            jobs.append({
                "title": match[0],
                "company": match[1],
                "location": match[2],
                "source": "json_extraction"
            })
    
    if jobs:
        print(f"Extracted {len(jobs)} jobs from embedded JSON")
    
    return jobs


async def main():
    print("=" * 60)
    print("Google Jobs Scraper with Camoufox")
    print("=" * 60)
    
    jobs = await scrape_google_jobs_camoufox(
        query="backend developer",
        location="San Francisco, CA",
        max_jobs=15
    )
    
    print(f"\n{'=' * 60}")
    print(f"RESULTS: Found {len(jobs)} jobs")
    print("=" * 60)
    
    for i, job in enumerate(jobs, 1):
        print(f"\n[{i}] {job.get('title', 'N/A')}")
        print(f"    Company: {job.get('company', 'N/A')}")
        print(f"    Location: {job.get('location', 'N/A')}")
    
    if jobs:
        # Save results to JSON
        with open("/tmp/camoufox_jobs.json", "w") as f:
            json.dump(jobs, f, indent=2)
        print(f"\nResults saved to /tmp/camoufox_jobs.json")
    
    return len(jobs) > 0


if __name__ == "__main__":
    success = asyncio.run(main())
    print(f"\n{'✅ SUCCESS' if success else '❌ NEEDS MORE WORK'}")
