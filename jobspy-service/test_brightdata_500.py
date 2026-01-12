"""
Test fetching 500 jobs using Bright Data residential proxy
"""
import asyncio
import csv
import json
from datetime import datetime
from typing import Optional

# Bright Data residential proxy with session rotation for new IP each request
def get_proxy_with_session():
    """Get proxy config with a random session for new IP"""
    import random
    import string
    session_id = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return {
        'server': 'http://brd.superproxy.io:33335',
        'username': f'brd-customer-hl_9189d3b5-zone-residential_proxy1-session-{session_id}',
        'password': 'scr58prz3kcj',
    }


async def scrape_google_jobs(
    query: str,
    location: str,
    max_jobs: int = 100,
    retry_count: int = 0
) -> list[dict]:
    """Scrape Google Jobs using Camoufox with Bright Data proxy and scroll pagination"""
    from camoufox.async_api import AsyncCamoufox
    
    jobs = []
    proxy = get_proxy_with_session()  # New IP each request
    
    print(f"  Searching: '{query}' in '{location}'")
    
    try:
        async with AsyncCamoufox(headless=True, proxy=proxy, geoip=True) as browser:
            context = await browser.new_context(ignore_https_errors=True)
            page = await context.new_page()
            
            # Build Google Jobs search URL
            search_query = f"{query} {location}".replace(" ", "+")
            url = f"https://www.google.com/search?q={search_query}&ibp=htl;jobs&sa=X"
            
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(4000)
            
            # Check if blocked
            content = await page.content()
            if 'unusual traffic' in content.lower():
                print(f"    BLOCKED by Google")
                return []
            
            # Initial extraction
            jobs = await extract_jobs_from_page(page, query, location)
            initial_count = len(jobs)
            
            # Scroll to load more jobs
            scroll_attempts = 0
            max_scroll_attempts = 20
            last_job_count = len(jobs)
            no_new_jobs_count = 0
            
            while len(jobs) < max_jobs and scroll_attempts < max_scroll_attempts:
                scroll_attempts += 1
                
                # Scroll strategies
                await page.evaluate("""
                    // Scroll job list containers
                    const containers = document.querySelectorAll('div[role="list"], ul, div[data-async-context]');
                    containers.forEach(c => c.scrollTop = c.scrollHeight);
                    
                    // Scroll main window
                    window.scrollTo(0, document.body.scrollHeight);
                    
                    // Google Jobs specific container
                    const jobContainer = document.querySelector('.gws-plugins-horizon-jobs__tl-lvc');
                    if (jobContainer) jobContainer.scrollTop = jobContainer.scrollHeight;
                """)
                
                await page.wait_for_timeout(1500)
                
                # Extract more jobs
                new_jobs = await extract_jobs_from_page(page, query, location)
                
                # Add unique jobs
                existing = {(j['title'].lower(), j['company'].lower()) for j in jobs}
                for job in new_jobs:
                    key = (job['title'].lower(), job['company'].lower())
                    if key not in existing:
                        jobs.append(job)
                        existing.add(key)
                
                # Check progress
                if len(jobs) == last_job_count:
                    no_new_jobs_count += 1
                    if no_new_jobs_count >= 3:
                        break
                else:
                    no_new_jobs_count = 0
                    last_job_count = len(jobs)
            
            scroll_added = len(jobs) - initial_count
            if scroll_added > 0:
                print(f"    Scrolling added {scroll_added} more jobs")
            
            print(f"    Found {len(jobs)} jobs")
            
    except Exception as e:
        error_msg = str(e)[:100]
        print(f"    Error: {error_msg}")
        
        # Retry with new session if proxy connection refused
        if 'PROXY_CONNECTION_REFUSED' in str(e) and retry_count < 3:
            print(f"    Retrying with new session (attempt {retry_count + 2})...")
            await asyncio.sleep(3)
            return await scrape_google_jobs(query, location, max_jobs, retry_count + 1)
    
    return jobs[:max_jobs]


async def extract_jobs_from_page(page, query: str, location: str) -> list[dict]:
    """Extract actual job listings from Google Jobs panel, not search snippets"""
    jobs = []
    
    try:
        # First try to get jobs from the job cards in the sidebar/panel
        # Google Jobs shows a list of job cards on the left side
        
        # Try to find actual job listing elements
        job_cards = await page.query_selector_all('li[data-ved], div[jsname="yEVEwb"], div.iFjolb')
        
        for card in job_cards:
            try:
                text = await card.inner_text()
                lines = [l.strip() for l in text.split('\n') if l.strip()]
                
                if len(lines) >= 2:
                    title = lines[0]
                    company = lines[1] if len(lines) > 1 else 'Unknown'
                    loc = lines[2] if len(lines) > 2 else location
                    
                    # Filter out non-job items
                    if len(title) > 10 and len(title) < 150:
                        skip_patterns = ['http', 'www.', '.com', '.ca', 'Search', 'Filter', 'Sign in']
                        if not any(p in title for p in skip_patterns):
                            job = {
                                'title': title,
                                'company': company.replace('•', '').strip(),
                                'location': loc.replace('•', '').strip(),
                                'search_query': query,
                            }
                            if not any(j['title'] == job['title'] for j in jobs):
                                jobs.append(job)
            except:
                continue
        
        # If no job cards found, fall back to text extraction
        if not jobs:
            body_text = await page.inner_text('body')
            lines = [l.strip() for l in body_text.split('\n') if l.strip()]
            
            job_keywords = [
                'Engineer', 'Developer', 'Manager', 'Designer', 'Analyst', 
                'Architect', 'Lead', 'Senior', 'Junior', 'Staff', 'Principal',
                'Full Stack', 'Frontend', 'Backend', 'DevOps', 'SRE', 'QA',
                'Programmer', 'Consultant', 'Specialist', 'Director'
            ]
            
            i = 0
            while i < len(lines) - 2 and len(jobs) < 50:
                line = lines[i]
                
                # Must have job keyword and be right length
                if any(kw.lower() in line.lower() for kw in job_keywords) and 10 < len(line) < 150:
                    # Skip search result snippets (URLs, descriptions)
                    skip_patterns = [
                        'http', 'www.', '.com', '.ca', '...', 'Search', 'Filter', 
                        'Sign in', 'Menu', 'Indeed', 'LinkedIn', 'Glassdoor',
                        'jobs in', 'Jobs in', 'salary', 'Salary', 'course',
                        'meaning', 'roadmap', 'Best', 'Find the', 'Apply to'
                    ]
                    
                    if not any(p in line for p in skip_patterns):
                        company = lines[i + 1] if i + 1 < len(lines) else 'Unknown'
                        loc = lines[i + 2] if i + 2 < len(lines) else location
                        
                        # Skip if company looks like a URL or snippet
                        if not any(p in company for p in ['http', '.com', '.ca', '...']):
                            company = company.replace('•', '').strip()
                            if company.startswith('via '):
                                company = company[4:]
                            
                            job = {
                                'title': line,
                                'company': company,
                                'location': loc.replace('•', '').strip(),
                                'search_query': query,
                            }
                            
                            if not any(j['title'] == job['title'] and j['company'] == job['company'] for j in jobs):
                                jobs.append(job)
                        i += 3
                        continue
                i += 1
            
    except Exception as e:
        print(f"    Extract error: {e}")
    
    return jobs


async def bulk_scrape(target_jobs: int = 500):
    """Scrape multiple queries to get target number of jobs"""
    
    location = "Toronto"
    
    # Query variations
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
        "junior software engineer",
        "devops engineer",
        "cloud engineer",
        "data engineer",
        "full stack developer",
        "typescript developer",
        "javascript developer",
        ".net developer",
        "mobile developer",
        "ios developer",
        "android developer",
        "qa engineer",
        "site reliability engineer",
        "platform engineer",
        "machine learning engineer",
        "solutions architect",
        "technical lead",
        "engineering manager",
        "application developer",
    ]
    
    print(f"Target: {target_jobs} jobs")
    print(f"Queries: {len(queries)}")
    print(f"Location: {location}")
    print("=" * 60)
    
    all_jobs = []
    jobs_per_query = max(30, target_jobs // len(queries))
    
    for i, query in enumerate(queries):
        if len(all_jobs) >= target_jobs:
            print(f"\nReached target of {target_jobs} jobs!")
            break
        
        print(f"\n[{i+1}/{len(queries)}] {query}")
        
        jobs = await scrape_google_jobs(
            query=query,
            location=location,
            max_jobs=jobs_per_query
        )
        
        # Add unique jobs
        existing = {(j['title'].lower(), j['company'].lower()) for j in all_jobs}
        new_count = 0
        for job in jobs:
            key = (job['title'].lower(), job['company'].lower())
            if key not in existing:
                all_jobs.append(job)
                existing.add(key)
                new_count += 1
        
        print(f"    Added {new_count} new unique jobs (total: {len(all_jobs)})")
        
        # Delay between queries
        await asyncio.sleep(2)
    
    return all_jobs


async def main():
    print("=" * 60)
    print("Google Jobs Scraper - Bright Data Residential Proxy Test")
    print("=" * 60)
    
    start_time = datetime.now()
    
    jobs = await bulk_scrape(target_jobs=500)
    
    elapsed = (datetime.now() - start_time).total_seconds()
    
    print("\n" + "=" * 60)
    print(f"RESULTS: {len(jobs)} unique jobs in {elapsed:.1f} seconds")
    print("=" * 60)
    
    # Show sample
    print("\nSample jobs:")
    for i, job in enumerate(jobs[:15], 1):
        print(f"  [{i}] {job['title']}")
        print(f"      {job['company']} - {job['location']}")
    
    # Save to CSV
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    csv_file = f"/Users/nick/Projects/ai-job-finder/exports/google_jobs_brightdata_{timestamp}.csv"
    
    with open(csv_file, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['title', 'company', 'location', 'search_query'])
        writer.writeheader()
        writer.writerows(jobs)
    
    print(f"\nSaved to {csv_file}")
    
    # Also JSON
    json_file = csv_file.replace('.csv', '.json')
    with open(json_file, 'w') as f:
        json.dump(jobs, f, indent=2)
    print(f"Also saved to {json_file}")
    
    return jobs


if __name__ == "__main__":
    import certifi
    import os
    os.environ['SSL_CERT_FILE'] = certifi.where()
    
    jobs = asyncio.run(main())
    print(f"\n{'✅ SUCCESS' if len(jobs) >= 100 else '⚠️ PARTIAL'}: {len(jobs)} jobs collected")
