"""
Bulk Google Jobs scraper using Camoufox with proxy rotation.
Scrapes multiple job title variations sequentially with different proxies.
"""
import asyncio
import csv
import json
import os
import re
from datetime import datetime
from typing import Optional

# Load proxies from env
from dotenv import load_dotenv
load_dotenv('/Users/nick/Projects/ai-job-finder/.env')

PROXIES = os.environ.get("JOBSPY_PROXIES", "").split(",")
PROXIES = [p.strip() for p in PROXIES if p.strip()]
print(f"Loaded {len(PROXIES)} proxies")


def parse_proxy_for_camoufox(proxy_url: str) -> dict:
    """Convert http://user:pass@host:port to Camoufox proxy format"""
    # Format: http://username:password@host:port
    match = re.match(r'https?://([^:]+):([^@]+)@([^:]+):(\d+)', proxy_url)
    if match:
        return {
            "server": f"http://{match.group(3)}:{match.group(4)}",
            "username": match.group(1),
            "password": match.group(2),
        }
    return None


async def scrape_google_jobs_with_proxy(
    query: str,
    location: str,
    proxy: Optional[str] = None,
    max_jobs: int = 100
) -> list[dict]:
    """Scrape Google Jobs using Camoufox with optional proxy and scroll pagination"""
    from camoufox.async_api import AsyncCamoufox
    
    jobs = []
    proxy_config = parse_proxy_for_camoufox(proxy) if proxy else None
    proxy_display = proxy.split("@")[1] if proxy and "@" in proxy else "direct"
    
    print(f"  Searching: '{query}' in '{location}' via {proxy_display}")
    
    try:
        # Add geoip=True when using proxy to match fingerprint to proxy location
        async with AsyncCamoufox(headless=True, proxy=proxy_config, geoip=True if proxy_config else False) as browser:
            page = await browser.new_page()
            
            # Build Google Jobs search URL
            search_query = f"{query} {location}".replace(" ", "+")
            url = f"https://www.google.com/search?q={search_query}&ibp=htl;jobs&sa=X"
            
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(4000)
            
            # Check if blocked by Google
            content = await page.content()
            if 'unusual traffic' in content.lower():
                print(f"    BLOCKED by Google - skipping this proxy")
                return []
            
            # Try to click Jobs tab
            try:
                jobs_tab = await page.query_selector('a[href*="ibp=htl;jobs"]')
                if jobs_tab:
                    await jobs_tab.click()
                    await page.wait_for_timeout(3000)
            except:
                pass
            
            # Find the job list container for scrolling
            job_list_selectors = [
                'div[role="list"]',
                'ul.gws-plugins-horizon-jobs__job-results',
                'div.gws-plugins-horizon-jobs__tl-lvc',
                '#search div[data-async-context]',
            ]
            
            # Initial extraction
            jobs = await extract_jobs_from_page(page, query, location, max_jobs)
            initial_count = len(jobs)
            
            # Aggressive scrolling to load more jobs
            scroll_attempts = 0
            max_scroll_attempts = 15  # More scroll attempts
            last_job_count = len(jobs)
            no_new_jobs_count = 0
            
            while len(jobs) < max_jobs and scroll_attempts < max_scroll_attempts:
                scroll_attempts += 1
                
                # Try multiple scroll strategies
                await page.evaluate("""
                    // Strategy 1: Scroll the job list container
                    const containers = document.querySelectorAll('div[role="list"], ul, div[data-async-context]');
                    containers.forEach(c => {
                        c.scrollTop = c.scrollHeight;
                    });
                    
                    // Strategy 2: Scroll the main window
                    window.scrollTo(0, document.body.scrollHeight);
                    
                    // Strategy 3: Find and scroll specific Google Jobs container
                    const jobContainer = document.querySelector('.gws-plugins-horizon-jobs__tl-lvc');
                    if (jobContainer) {
                        jobContainer.scrollTop = jobContainer.scrollHeight;
                    }
                """)
                
                await page.wait_for_timeout(1500)  # Wait for new jobs to load
                
                # Extract jobs again
                new_jobs = await extract_jobs_from_page(page, query, location, max_jobs * 2)
                
                # Add only new unique jobs
                existing = {(j['title'].lower(), j['company'].lower()) for j in jobs}
                added = 0
                for job in new_jobs:
                    key = (job['title'].lower(), job['company'].lower())
                    if key not in existing:
                        jobs.append(job)
                        existing.add(key)
                        added += 1
                
                # Check if we're making progress
                if len(jobs) == last_job_count:
                    no_new_jobs_count += 1
                    if no_new_jobs_count >= 3:
                        break  # No new jobs after 3 attempts, stop scrolling
                else:
                    no_new_jobs_count = 0
                    last_job_count = len(jobs)
            
            if len(jobs) > initial_count:
                print(f"    Scrolling added {len(jobs) - initial_count} more jobs")
            
            print(f"    Found {len(jobs)} jobs total")
            
    except Exception as e:
        print(f"    Error: {str(e)[:100]}")
    
    return jobs[:max_jobs]


async def extract_jobs_from_page(page, query: str, location: str, max_jobs: int) -> list[dict]:
    """Extract jobs from visible page content"""
    jobs = []
    
    try:
        body_text = await page.inner_text('body')
        lines = [l.strip() for l in body_text.split('\n') if l.strip()]
        
        # Keywords that indicate job titles
        job_keywords = [
            'Engineer', 'Developer', 'Manager', 'Designer', 'Analyst', 
            'Architect', 'Lead', 'Senior', 'Junior', 'Staff', 'Principal',
            'Full Stack', 'Frontend', 'Backend', 'DevOps', 'SRE', 'QA',
            'Programmer', 'Consultant', 'Specialist', 'Director', 'VP'
        ]
        
        i = 0
        while i < len(lines) - 2 and len(jobs) < max_jobs:
            line = lines[i]
            
            # Check if line looks like a job title
            if any(kw.lower() in line.lower() for kw in job_keywords) and len(line) > 10 and len(line) < 150:
                # Skip filter/navigation items
                skip_words = ['Last', 'Date', 'Sort', 'Filter', 'Search', 'Sign in', 'Menu', 'More']
                if not any(sw in line for sw in skip_words):
                    company = lines[i + 1] if i + 1 < len(lines) else 'Unknown'
                    loc = lines[i + 2] if i + 2 < len(lines) else location
                    
                    # Clean up company (remove bullets, etc)
                    company = company.replace('•', '').strip()
                    if company.startswith('via '):
                        company = 'Unknown'
                    
                    job = {
                        'title': line,
                        'company': company,
                        'location': loc.replace('•', '').strip(),
                        'search_query': query,
                        'search_location': location,
                    }
                    
                    # Avoid duplicates
                    if not any(j['title'] == job['title'] and j['company'] == job['company'] for j in jobs):
                        jobs.append(job)
                    i += 3
                    continue
            i += 1
            
    except Exception as e:
        print(f"    Extract error: {e}")
    
    return jobs


async def bulk_scrape_google_jobs(
    base_query: str,
    location: str,
    target_jobs: int = 1000
) -> list[dict]:
    """
    Scrape Google Jobs with multiple query variations and proxy rotation.
    Each variation uses a different proxy.
    """
    
    # Generate query variations - much more comprehensive
    base_variations = [
        base_query,
        base_query.replace("full stack", "fullstack"),
        base_query.replace("software engineer", "software developer"),
        base_query.replace("full stack", "full-stack"),
        f"senior {base_query}",
        f"junior {base_query}",
        f"{base_query} remote",
        base_query.replace("full stack software engineer", "full stack developer"),
        base_query.replace("full stack software engineer", "web developer"),
        base_query.replace("full stack software engineer", "frontend developer"),
        base_query.replace("full stack software engineer", "backend developer"),
        base_query.replace("full stack software engineer", "react developer"),
        base_query.replace("full stack software engineer", "node.js developer"),
        base_query.replace("full stack software engineer", "python developer"),
        base_query.replace("full stack software engineer", "java developer"),
        f"staff {base_query}",
        f"lead {base_query}",
        f"principal {base_query}",
        base_query.replace("software engineer", "programmer"),
        base_query.replace("full stack", "").strip(),  # Just "software engineer"
    ]
    
    # Add more tech-specific variations
    tech_variations = [
        "typescript developer",
        "javascript developer",
        "angular developer",
        "vue.js developer",
        "django developer",
        "ruby on rails developer",
        "golang developer",
        "rust developer",
        ".net developer",
        "c# developer",
        "php developer",
        "laravel developer",
        "aws developer",
        "cloud engineer",
        "devops engineer",
        "site reliability engineer",
        "platform engineer",
        "software architect",
        "solutions architect",
        "technical lead",
        "engineering manager",
        "software development engineer",
        "application developer",
        "systems developer",
        "api developer",
        "microservices developer",
        "mobile developer",
        "ios developer",
        "android developer",
        "flutter developer",
        "react native developer",
        "database developer",
        "sql developer",
        "data engineer",
        "machine learning engineer",
        "ai engineer",
        "qa engineer",
        "automation engineer",
        "test engineer",
        "integration developer",
        "middleware developer",
    ]
    
    # Seniority variations for key roles
    seniority_prefixes = ["", "senior ", "junior ", "lead ", "staff ", "principal "]
    core_roles = ["software engineer", "software developer", "full stack developer", "web developer"]
    
    seniority_variations = []
    for prefix in seniority_prefixes:
        for role in core_roles:
            seniority_variations.append(f"{prefix}{role}".strip())
    
    # Combine all variations
    query_variations = base_variations + tech_variations + seniority_variations
    
    # Remove duplicates while preserving order
    seen = set()
    unique_variations = []
    for q in query_variations:
        q_clean = q.strip()
        if q_clean and q_clean.lower() not in seen:
            seen.add(q_clean.lower())
            unique_variations.append(q_clean)
    
    print(f"\nWill search {len(unique_variations)} query variations:")
    for i, q in enumerate(unique_variations):
        print(f"  {i+1}. {q}")
    
    all_jobs = []
    jobs_per_query = max(50, target_jobs // len(unique_variations))
    
    print(f"\nTarget: ~{jobs_per_query} jobs per query variation")
    print(f"Using {len(PROXIES)} proxies in rotation")
    print("=" * 60)
    
    for i, query in enumerate(unique_variations):
        if len(all_jobs) >= target_jobs:
            print(f"\nReached target of {target_jobs} jobs, stopping early")
            break
        
        # For now, don't use proxies - Google blocks datacenter IPs
        # In production, would need residential proxies
        proxy = None  # PROXIES[i % len(PROXIES)] if PROXIES else None
        
        print(f"\n[{i+1}/{len(unique_variations)}] Query: '{query}'")
        
        jobs = await scrape_google_jobs_with_proxy(
            query=query,
            location=location,
            proxy=proxy,
            max_jobs=jobs_per_query
        )
        
        # Add only unique jobs
        existing = {(j['title'].lower(), j['company'].lower()) for j in all_jobs}
        new_count = 0
        for job in jobs:
            key = (job['title'].lower(), job['company'].lower())
            if key not in existing:
                all_jobs.append(job)
                existing.add(key)
                new_count += 1
        
        print(f"    Added {new_count} new unique jobs (total: {len(all_jobs)})")
        
        # Small delay between requests to be polite
        await asyncio.sleep(2)
    
    return all_jobs


def save_to_csv(jobs: list[dict], filename: str):
    """Save jobs to CSV file"""
    if not jobs:
        print("No jobs to save")
        return
    
    # Determine all fields
    fieldnames = ['title', 'company', 'location', 'search_query', 'search_location']
    
    with open(filename, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for job in jobs:
            writer.writerow({k: job.get(k, '') for k in fieldnames})
    
    print(f"\nSaved {len(jobs)} jobs to {filename}")


async def main():
    print("=" * 60)
    print("Bulk Google Jobs Scraper with Camoufox + Proxies")
    print("=" * 60)
    
    # Target search
    base_query = "full stack software engineer"
    location = "Toronto"
    target_jobs = 1000
    
    print(f"\nBase query: '{base_query}'")
    print(f"Location: {location}")
    print(f"Target jobs: {target_jobs}")
    
    start_time = datetime.now()
    
    jobs = await bulk_scrape_google_jobs(
        base_query=base_query,
        location=location,
        target_jobs=target_jobs
    )
    
    elapsed = (datetime.now() - start_time).total_seconds()
    
    print("\n" + "=" * 60)
    print(f"RESULTS: Found {len(jobs)} unique jobs in {elapsed:.1f} seconds")
    print("=" * 60)
    
    # Show sample
    print("\nSample jobs:")
    for i, job in enumerate(jobs[:10], 1):
        print(f"  [{i}] {job['title']}")
        print(f"      Company: {job['company']}")
        print(f"      Location: {job['location']}")
    
    # Save to CSV
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    csv_filename = f"/Users/nick/Projects/ai-job-finder/exports/google_jobs_{timestamp}.csv"
    save_to_csv(jobs, csv_filename)
    
    # Also save as JSON for reference
    json_filename = f"/Users/nick/Projects/ai-job-finder/exports/google_jobs_{timestamp}.json"
    with open(json_filename, 'w') as f:
        json.dump(jobs, f, indent=2)
    print(f"Also saved to {json_filename}")
    
    return jobs


if __name__ == "__main__":
    jobs = asyncio.run(main())
    print(f"\n{'✅ SUCCESS' if len(jobs) > 0 else '❌ NO JOBS FOUND'}")
