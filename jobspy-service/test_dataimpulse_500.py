"""
Test fetching 500 jobs using DataImpulse residential proxy
"""
import asyncio
import csv
import json
import random
import string
from datetime import datetime

# DataImpulse proxy - add session ID for IP rotation
def get_dataimpulse_proxy():
    """Get DataImpulse proxy with random session for new IP"""
    session_id = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return {
        'server': 'http://gw.dataimpulse.com:823',
        'username': f'09155740b71c7845c38e__cr.us,ca__sid.{session_id}',
        'password': '11cff52a1368d5b0',
    }


async def scrape_google_jobs(
    query: str,
    location: str,
    max_jobs: int = 100,
    retry_count: int = 0
) -> list[dict]:
    """Scrape Google Jobs with DataImpulse proxy and scroll pagination"""
    from camoufox.async_api import AsyncCamoufox
    
    jobs = []
    proxy = get_dataimpulse_proxy()
    
    print(f"  Searching: '{query}' in '{location}'")
    
    try:
        async with AsyncCamoufox(headless=True, proxy=proxy, geoip=True) as browser:
            context = await browser.new_context(ignore_https_errors=True)
            page = await context.new_page()
            
            # Build Google Jobs URL
            search_query = f"{query} {location}".replace(" ", "+")
            url = f"https://www.google.com/search?q={search_query}&ibp=htl;jobs&sa=X"
            
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(4000)
            
            # Check if blocked
            content = await page.content()
            if 'unusual traffic' in content.lower():
                print(f"    BLOCKED - retrying with new session...")
                if retry_count < 3:
                    await asyncio.sleep(2)
                    return await scrape_google_jobs(query, location, max_jobs, retry_count + 1)
                return []
            
            # Initial extraction
            jobs = await extract_jobs_from_page(page, query, location)
            initial_count = len(jobs)
            
            # Scroll to load more jobs
            scroll_attempts = 0
            max_scroll_attempts = 15
            last_job_count = len(jobs)
            no_new_jobs_count = 0
            
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
                
                new_jobs = await extract_jobs_from_page(page, query, location)
                
                existing = {(j['title'].lower(), j['company'].lower()) for j in jobs}
                for job in new_jobs:
                    key = (job['title'].lower(), job['company'].lower())
                    if key not in existing:
                        jobs.append(job)
                        existing.add(key)
                
                if len(jobs) == last_job_count:
                    no_new_jobs_count += 1
                    if no_new_jobs_count >= 3:
                        break
                else:
                    no_new_jobs_count = 0
                    last_job_count = len(jobs)
            
            if len(jobs) > initial_count:
                print(f"    Scrolling added {len(jobs) - initial_count} more")
            
            print(f"    Found {len(jobs)} jobs")
            
    except Exception as e:
        error_msg = str(e)[:80]
        print(f"    Error: {error_msg}")
        if retry_count < 3:
            await asyncio.sleep(2)
            return await scrape_google_jobs(query, location, max_jobs, retry_count + 1)
    
    return jobs[:max_jobs]


async def extract_jobs_from_page(page, query: str, location: str) -> list[dict]:
    """Extract job listings from page"""
    jobs = []
    
    try:
        body_text = await page.inner_text('body')
        lines = [l.strip() for l in body_text.split('\n') if l.strip()]
        
        job_keywords = [
            'Engineer', 'Developer', 'Manager', 'Designer', 'Analyst', 
            'Architect', 'Lead', 'Senior', 'Junior', 'Staff', 'Principal',
            'Full Stack', 'Frontend', 'Backend', 'DevOps', 'SRE', 'QA',
            'Programmer', 'Consultant', 'Specialist', 'Director'
        ]
        
        skip_patterns = [
            'http', 'www.', '.com', '.ca', '...', 'Search', 'Filter', 
            'Sign in', 'Menu', 'Indeed', 'LinkedIn', 'Glassdoor',
            'jobs in', 'Jobs in', 'salary', 'Salary', 'course',
            'meaning', 'roadmap', 'Best', 'Find the', 'Apply to'
        ]
        
        i = 0
        while i < len(lines) - 2 and len(jobs) < 100:
            line = lines[i]
            
            if any(kw.lower() in line.lower() for kw in job_keywords) and 10 < len(line) < 150:
                if not any(p in line for p in skip_patterns):
                    company = lines[i + 1] if i + 1 < len(lines) else 'Unknown'
                    loc = lines[i + 2] if i + 2 < len(lines) else location
                    
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
    """Scrape multiple queries to reach target"""
    
    location = "Toronto"
    
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
        "c# developer",
        "golang developer",
        "ruby developer",
        "php developer",
        "aws engineer",
        "azure engineer",
        "kubernetes engineer",
        "security engineer",
        "systems engineer",
        "infrastructure engineer",
    ]
    
    print(f"Target: {target_jobs} jobs")
    print(f"Queries: {len(queries)}")
    print(f"Location: {location}")
    print("=" * 60)
    
    all_jobs = []
    
    for i, query in enumerate(queries):
        if len(all_jobs) >= target_jobs:
            print(f"\nReached target of {target_jobs} jobs!")
            break
        
        print(f"\n[{i+1}/{len(queries)}] {query}")
        
        jobs = await scrape_google_jobs(
            query=query,
            location=location,
            max_jobs=50
        )
        
        existing = {(j['title'].lower(), j['company'].lower()) for j in all_jobs}
        new_count = 0
        for job in jobs:
            key = (job['title'].lower(), job['company'].lower())
            if key not in existing:
                all_jobs.append(job)
                existing.add(key)
                new_count += 1
        
        print(f"    Added {new_count} unique (total: {len(all_jobs)})")
        
        await asyncio.sleep(1)
    
    return all_jobs


async def main():
    print("=" * 60)
    print("Google Jobs - DataImpulse Proxy Test (500 jobs)")
    print("=" * 60)
    
    start_time = datetime.now()
    
    jobs = await bulk_scrape(target_jobs=500)
    
    elapsed = (datetime.now() - start_time).total_seconds()
    
    print("\n" + "=" * 60)
    print(f"RESULTS: {len(jobs)} unique jobs in {elapsed:.1f}s")
    print("=" * 60)
    
    print("\nSample jobs:")
    for i, job in enumerate(jobs[:15], 1):
        print(f"  [{i}] {job['title']}")
        print(f"      {job['company']} - {job['location']}")
    
    # Save CSV
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    csv_file = f"/Users/nick/Projects/ai-job-finder/exports/google_jobs_dataimpulse_{timestamp}.csv"
    
    with open(csv_file, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['title', 'company', 'location', 'search_query'])
        writer.writeheader()
        writer.writerows(jobs)
    
    print(f"\nSaved to {csv_file}")
    
    # JSON
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
    print(f"\n{'✅ SUCCESS' if len(jobs) >= 100 else '⚠️ PARTIAL'}: {len(jobs)} jobs")
