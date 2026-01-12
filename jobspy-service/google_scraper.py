"""
Google Jobs Scraper using Camoufox and DataImpulse residential proxies.

DataImpulse Proxy Rotation:
- Uses a single gateway: gw.dataimpulse.com:823
- Rotating IPs via session ID: append __sid.{random} to username
- Each new session ID = new residential IP
- No need to fetch proxy lists - gateway handles rotation

Usage:
    from google_scraper import GoogleJobsScraper
    
    scraper = GoogleJobsScraper()
    jobs = await scraper.scrape("software engineer", "Toronto", max_jobs=50)
"""
import asyncio
import os
import random
import re
import string
import logging
from typing import Optional
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class ApplyUrl:
    """A single apply URL from a job listing."""
    url: str
    source: str  # e.g., "LinkedIn", "Indeed", "Company Website"


@dataclass 
class GoogleJob:
    """A job listing from Google Jobs."""
    title: str
    company: str
    location: str
    description: Optional[str] = None
    apply_urls: list[ApplyUrl] = field(default_factory=list)
    search_query: str = ""


class DataImpulseProxy:
    """
    DataImpulse residential proxy with automatic IP rotation.
    
    IP Rotation: Each request with a new session ID gets a new residential IP.
    No need to fetch proxy lists - the gateway handles rotation automatically.
    """
    
    def __init__(
        self,
        login: Optional[str] = None,
        password: Optional[str] = None,
        host: str = "gw.dataimpulse.com",
        port: int = 823,
        countries: list[str] = None,
    ):
        self.login = login or os.getenv("DATAIMPULSE_LOGIN")
        self.password = password or os.getenv("DATAIMPULSE_PASSWORD")
        if not self.login or not self.password:
            raise ValueError("DATAIMPULSE_LOGIN and DATAIMPULSE_PASSWORD environment variables required")
        self.host = host
        self.port = port
        self.countries = countries or ["us", "ca"]  # Default: US and Canada
    
    def get_proxy_config(self) -> dict:
        """
        Get a proxy config with a fresh session ID for a new IP.
        
        The session ID in the username determines the IP:
        - Same session ID = same IP (sticky session)
        - New session ID = new IP (rotation)
        
        Format: {login}__cr.{countries}__sid.{session_id}
        """
        session_id = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
        country_param = ','.join(self.countries)
        
        username = f"{self.login}__cr.{country_param}__sid.{session_id}"
        
        return {
            'server': f'http://{self.host}:{self.port}',
            'username': username,
            'password': self.password,
        }


class GoogleJobsScraper:
    """
    Scrapes Google Jobs using Camoufox (stealthy Firefox) with residential proxies.
    
    Key features:
    - Uses Camoufox to avoid bot detection
    - Rotates residential IPs via DataImpulse for each request
    - Extracts ALL apply URLs from each job (LinkedIn, Indeed, company site, etc.)
    - Scroll pagination to load more jobs
    """
    
    def __init__(self, proxy_provider: Optional[DataImpulseProxy] = None):
        self.proxy = proxy_provider or DataImpulseProxy()
    
    async def scrape(
        self,
        query: str,
        location: str,
        max_jobs: int = 50,
        max_retries: int = 3,
    ) -> list[GoogleJob]:
        """
        Scrape Google Jobs for the given query and location.
        
        Args:
            query: Job title/keywords to search
            location: Location to search in
            max_jobs: Maximum number of jobs to return
            max_retries: Number of retry attempts on failure/blocks
            
        Returns:
            List of GoogleJob objects with apply URLs from all sources
        """
        for attempt in range(max_retries):
            try:
                jobs = await self._scrape_with_proxy(query, location, max_jobs)
                if jobs:
                    return jobs
                logger.warning(f"Attempt {attempt + 1}/{max_retries}: No jobs found, retrying...")
            except Exception as e:
                logger.warning(f"Attempt {attempt + 1}/{max_retries}: Error - {str(e)[:100]}")
            
            await asyncio.sleep(2)
        
        logger.error(f"Failed to scrape Google Jobs after {max_retries} attempts")
        return []
    
    async def _scrape_with_proxy(
        self,
        query: str,
        location: str,
        max_jobs: int,
    ) -> list[GoogleJob]:
        """Scrape with a fresh proxy session."""
        try:
            from camoufox.async_api import AsyncCamoufox
        except ImportError:
            logger.error("Camoufox not installed. Run: pip install camoufox[geoip]")
            return []
        
        proxy_config = self.proxy.get_proxy_config()
        logger.info(f"Scraping Google Jobs: '{query}' in '{location}' (session: {proxy_config['username'][-8:]})")
        
        async with AsyncCamoufox(headless=True, proxy=proxy_config, geoip=True) as browser:
            context = await browser.new_context(ignore_https_errors=True)
            page = await context.new_page()
            
            # Build Google Jobs URL
            search_query = f"{query} {location}".replace(" ", "+")
            url = f"https://www.google.com/search?q={search_query}&ibp=htl;jobs&sa=X"
            
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(4000)
            
            # Check for blocking
            content = await page.content()
            if 'unusual traffic' in content.lower():
                raise Exception("Blocked by Google - unusual traffic detected")
            
            if len(content) < 50000:
                raise Exception(f"Partial page load - only {len(content)} bytes")
            
            # Extract jobs with scroll pagination
            jobs = await self._extract_jobs_with_scroll(page, query, location, max_jobs)
            
            return jobs
    
    async def _extract_jobs_with_scroll(
        self,
        page,
        query: str,
        location: str,
        max_jobs: int,
    ) -> list[GoogleJob]:
        """Extract jobs with scroll pagination to load more."""
        all_jobs: list[GoogleJob] = []
        scroll_attempts = 0
        max_scroll_attempts = 15
        no_new_jobs_count = 0
        
        while len(all_jobs) < max_jobs and scroll_attempts < max_scroll_attempts:
            # Get current page content
            html = await page.content()
            body_text = await page.inner_text('body')
            
            # Extract jobs from current view
            new_jobs = self._parse_jobs_from_html(html, body_text, query, location)
            
            # Deduplicate
            existing_keys = {(j.title.lower(), j.company.lower()) for j in all_jobs}
            added = 0
            for job in new_jobs:
                key = (job.title.lower(), job.company.lower())
                if key not in existing_keys:
                    all_jobs.append(job)
                    existing_keys.add(key)
                    added += 1
            
            if added == 0:
                no_new_jobs_count += 1
                if no_new_jobs_count >= 3:
                    break
            else:
                no_new_jobs_count = 0
            
            # Scroll to load more
            scroll_attempts += 1
            await page.evaluate("""
                const containers = document.querySelectorAll('div[role="list"], ul');
                containers.forEach(c => c.scrollTop = c.scrollHeight);
                window.scrollTo(0, document.body.scrollHeight);
                const jobContainer = document.querySelector('.gws-plugins-horizon-jobs__tl-lvc');
                if (jobContainer) jobContainer.scrollTop = jobContainer.scrollHeight;
            """)
            await page.wait_for_timeout(1500)
        
        logger.info(f"Extracted {len(all_jobs)} jobs from Google Jobs")
        return all_jobs[:max_jobs]
    
    def _parse_jobs_from_html(
        self,
        html: str,
        body_text: str,
        query: str,
        location: str,
    ) -> list[GoogleJob]:
        """Parse job listings and apply URLs from HTML."""
        jobs: list[GoogleJob] = []
        
        # Extract job titles from visible text
        job_data = self._extract_job_titles(body_text, location)
        
        # Extract apply URLs and match to jobs
        url_groups = self._extract_apply_urls(html)
        
        # Match URLs to jobs (they appear in same order)
        for i, data in enumerate(job_data):
            apply_urls = url_groups[i] if i < len(url_groups) else []
            
            job = GoogleJob(
                title=data['title'],
                company=data['company'],
                location=data['location'],
                apply_urls=apply_urls,
                search_query=query,
            )
            jobs.append(job)
        
        return jobs
    
    def _extract_job_titles(self, body_text: str, default_location: str) -> list[dict]:
        """Extract job titles, companies, and locations from page text."""
        lines = [l.strip() for l in body_text.split('\n') if l.strip()]
        
        job_keywords = [
            'Engineer', 'Developer', 'Manager', 'Designer', 'Analyst',
            'Architect', 'Lead', 'Senior', 'Junior', 'Staff', 'Principal',
            'Full Stack', 'Frontend', 'Backend', 'DevOps', 'SRE', 'QA',
            'Programmer', 'Consultant', 'Specialist', 'Director', 'Scientist',
            'Administrator', 'Coordinator', 'Technician', 'Associate',
        ]
        
        skip_patterns = [
            'http', 'www.', '.com', '.ca', '...', 'Search', 'Filter',
            'Sign in', 'Menu', 'Indeed', 'LinkedIn', 'Glassdoor',
            'jobs in', 'Jobs in', 'salary', 'Salary', 'course',
            'meaning', 'roadmap', 'Best', 'Find the', 'Apply to',
        ]
        
        jobs = []
        i = 0
        while i < len(lines) - 2 and len(jobs) < 100:
            line = lines[i]
            
            if any(kw.lower() in line.lower() for kw in job_keywords) and 10 < len(line) < 150:
                if not any(p in line for p in skip_patterns):
                    company = lines[i + 1] if i + 1 < len(lines) else 'Unknown'
                    loc = lines[i + 2] if i + 2 < len(lines) else default_location
                    
                    if not any(p in company for p in ['http', '.com', '.ca', '...']):
                        company = company.replace('•', '').strip()
                        if company.startswith('via '):
                            company = company[4:]
                        
                        jobs.append({
                            'title': line,
                            'company': company,
                            'location': loc.replace('•', '').strip(),
                        })
                    i += 3
                    continue
            i += 1
        
        return jobs
    
    def _extract_apply_urls(self, html: str) -> list[list[ApplyUrl]]:
        """
        Extract apply URLs grouped by job from HTML.
        
        Google Jobs embeds apply links in a specific pattern:
        ["https://...google_jobs_apply...", "domain", "Source Name", ...]
        
        URLs appear in groups matching the job listing order.
        """
        # Pattern to match apply URLs with source
        url_pattern = r'\["(https://[^"]+google_jobs_apply[^"]+)","?([^",]*)","([^"]+)"'
        
        url_groups: list[list[ApplyUrl]] = []
        current_group: list[ApplyUrl] = []
        last_pos = 0
        
        for match in re.finditer(url_pattern, html):
            pos = match.start()
            
            # Gap > 1000 chars indicates new job
            if last_pos > 0 and pos - last_pos > 1000:
                if current_group:
                    url_groups.append(current_group)
                current_group = []
            
            url = match.group(1)
            source = match.group(3)
            
            # Clean URL escapes
            url = url.replace('\\u003d', '=').replace('\\u0026', '&')
            
            current_group.append(ApplyUrl(url=url, source=source))
            last_pos = match.end()
        
        if current_group:
            url_groups.append(current_group)
        
        return url_groups


# FastAPI endpoint handler (called from main.py)
async def scrape_google_jobs(
    query: str,
    location: str,
    max_jobs: int = 50,
    countries: list[str] = None,
) -> list[dict]:
    """
    API handler for Google Jobs scraping.
    
    Returns list of jobs with all apply URLs.
    """
    proxy = DataImpulseProxy(countries=countries) if countries else None
    scraper = GoogleJobsScraper(proxy_provider=proxy)
    
    jobs = await scraper.scrape(query, location, max_jobs=max_jobs)
    
    # Convert to dict for JSON serialization
    return [
        {
            'title': job.title,
            'company': job.company,
            'location': job.location,
            'description': job.description,
            'apply_urls': [
                {'url': url.url, 'source': url.source}
                for url in job.apply_urls
            ],
            'search_query': job.search_query,
            'source': 'google_jobs',
        }
        for job in jobs
    ]
