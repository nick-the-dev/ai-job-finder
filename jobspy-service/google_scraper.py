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
    posted_date: Optional[str] = None  # e.g., "2 days ago", "1 week ago"


# Date filter mappings - these phrases work in Google Jobs search
DATE_FILTER_PHRASES = {
    "today": "since yesterday",
    "3days": "in the last 3 days",
    "week": "in the last week",
    "month": "in the last month",
    # No filter for "all" - just search without date phrase
}


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
        # Use only US for consistent English results
        self.countries = countries or ["us"]
    
    def get_proxy_config(self) -> dict:
        """
        Get a proxy config with a fresh session ID for a new IP.
        
        The session ID in the username determines the IP:
        - Same session ID = same IP (sticky session)
        - New session ID = new IP (rotation)
        
        Format: {login}__cr.{country}__sid.{session_id}
        DataImpulse uses ISO 3166-1 alpha-2 country codes
        """
        session_id = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
        # Use first country only - DataImpulse doesn't support multiple in one request
        country = self.countries[0] if self.countries else "us"
        
        username = f"{self.login}__cr.{country}__sid.{session_id}"
        
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
        max_jobs: int = 10000,  # High default - we scroll until no more jobs
        date_posted: str = "month",  # today, 3days, week, month, or all
        max_retries: int = 3,
    ) -> list[GoogleJob]:
        """
        Scrape Google Jobs for the given query and location.
        
        Args:
            query: Job title/keywords to search
            location: Location to search in
            max_jobs: Maximum number of jobs to return (default 10000 - effectively unlimited)
            date_posted: Filter by date - today, 3days, week, month, or all
            max_retries: Number of retry attempts on failure/blocks
            
        Returns:
            List of GoogleJob objects with apply URLs from all sources
        """
        for attempt in range(max_retries):
            try:
                jobs = await self._scrape_with_proxy(query, location, max_jobs, date_posted)
                if jobs:
                    return jobs
                logger.warning(f"Attempt {attempt + 1}/{max_retries}: No jobs found, retrying...")
            except Exception as e:
                logger.warning(f"Attempt {attempt + 1}/{max_retries}: Error - {str(e)[:100]}")
            
            # Exponential backoff with jitter
            delay = (2 ** attempt) + random.uniform(1, 3)
            await asyncio.sleep(delay)
        
        logger.error(f"Failed to scrape Google Jobs after {max_retries} attempts")
        return []
    
    async def _scrape_with_proxy(
        self,
        query: str,
        location: str,
        max_jobs: int,
        date_posted: str = "month",
    ) -> list[GoogleJob]:
        """Scrape with a fresh proxy session."""
        try:
            from camoufox.async_api import AsyncCamoufox
        except ImportError:
            logger.error("Camoufox not installed. Run: pip install camoufox[geoip]")
            return []
        
        proxy_config = self.proxy.get_proxy_config()
        
        # Build search query with date filter
        date_phrase = DATE_FILTER_PHRASES.get(date_posted, "")
        if date_phrase:
            full_query = f"{query} {location} {date_phrase}"
        else:
            full_query = f"{query} {location}"
        
        logger.info(f"Scraping Google Jobs: '{full_query}' (date_posted={date_posted}, session: {proxy_config['username'][-8:]})")
        
        async with AsyncCamoufox(headless=True, proxy=proxy_config, geoip=True) as browser:
            context = await browser.new_context(ignore_https_errors=True)
            page = await context.new_page()
            
            # Build Google Jobs URL with proper encoding and English language
            from urllib.parse import quote_plus
            search_query = quote_plus(full_query)
            url = f"https://www.google.com/search?q={search_query}&ibp=htl;jobs&sa=X&hl=en"
            
            # Navigate with realistic timing
            await page.goto(url, wait_until="domcontentloaded", timeout=45000)
            
            # Wait for page to fully load with human-like delay
            await page.wait_for_timeout(random.randint(3000, 5000))
            
            # Handle EU consent dialog if present
            if 'consent.google' in page.url:
                logger.info("Consent dialog detected, accepting...")
                try:
                    # Try to click "Accept all" button
                    accept_btn = await page.query_selector('button:has-text("Accept all")')
                    if accept_btn:
                        await accept_btn.click()
                        await page.wait_for_timeout(3000)
                        logger.info(f"Consent accepted, now at: {page.url}")
                except Exception as e:
                    logger.warning(f"Could not accept consent: {e}")
            
            # Check for blocking
            content = await page.content()
            if 'unusual traffic' in content.lower() or 'captcha' in content.lower():
                raise Exception("Blocked by Google - unusual traffic detected")
            
            if len(content) < 50000:
                raise Exception(f"Partial page load - only {len(content)} bytes")
            
            # Extract jobs with scroll pagination - scroll until no more jobs
            jobs = await self._extract_jobs_with_scroll(page, query, location, max_jobs, date_posted)
            
            return jobs
    
    async def _extract_jobs_with_scroll(
        self,
        page,
        query: str,
        location: str,
        max_jobs: int,
        date_posted: str = "month",
    ) -> list[GoogleJob]:
        """Extract jobs by clicking each job card and extracting details from right panel.
        
        This approach:
        1. Uses mouse wheel to scroll and load more jobs dynamically
        2. Clicks each job card to load its details in the right panel
        3. Clicks "show full description" to expand the description
        4. Extracts title, company, location, salary, job type, description, and apply URLs
        5. Only clicks NEW job cards (tracks what's been clicked)
        """
        all_jobs: list[GoogleJob] = []
        clicked_titles: set[str] = set()  # Track clicked job titles to avoid re-clicking
        no_new_jobs_count = 0
        
        # Dynamic limits based on date range
        max_no_new_scrolls = {
            "today": 10,
            "3days": 12,
            "week": 15,
            "month": 20,
            "all": 25,
        }.get(date_posted, 15)
        
        logger.info(f"Starting click-based extraction (max_jobs={max_jobs}, max_no_new_scrolls={max_no_new_scrolls})")
        
        while len(all_jobs) < max_jobs and no_new_jobs_count < max_no_new_scrolls:
            # Find all visible job cards in left panel
            cards = await page.evaluate('''() => {
                const cards = [];
                for (const el of document.querySelectorAll('li, div')) {
                    const rect = el.getBoundingClientRect();
                    if (rect.left > 0 && rect.left < 400 &&
                        rect.width > 200 && rect.width < 500 &&
                        rect.height > 60 && rect.height < 200 &&
                        rect.top > 150 && rect.top < 700) {
                        const text = (el.innerText || '').trim();
                        const lines = text.split('\\n').filter(l => l.trim());
                        if (lines.length >= 2 && lines.length <= 10 && lines[0].length > 10) {
                            cards.push({
                                x: rect.left + rect.width/2,
                                y: rect.top + rect.height/2,
                                title: lines[0]
                            });
                        }
                    }
                }
                // Dedupe by title within this batch
                const seen = new Set();
                return cards.filter(c => {
                    if (seen.has(c.title)) return false;
                    seen.add(c.title);
                    return true;
                });
            }''')
            
            # Only process cards we haven't clicked before
            new_cards = [c for c in cards if c['title'] not in clicked_titles]
            
            if not new_cards:
                # No new cards visible, scroll to load more
                await page.mouse.move(300, 500)
                await page.mouse.wheel(0, 300)
                await page.wait_for_timeout(1000)
                no_new_jobs_count += 1
                continue
            
            no_new_jobs_count = 0  # Reset since we found new cards
            
            for card in new_cards:
                if len(all_jobs) >= max_jobs:
                    break
                
                clicked_titles.add(card['title'])
                
                # Click the job card
                await page.mouse.click(card['x'], card['y'])
                await page.wait_for_timeout(2000)  # Wait for right panel to load
                
                # Click "show full description" if present
                for _ in range(2):
                    clicked = await page.evaluate('''() => {
                        for (const el of document.querySelectorAll('span, div, button')) {
                            const rect = el.getBoundingClientRect();
                            const text = (el.innerText || '').toLowerCase().trim();
                            if (rect.left > 400 && rect.top > 100 && text === 'show full description') {
                                el.click();
                                return true;
                            }
                        }
                        return false;
                    }''')
                    if clicked:
                        await page.wait_for_timeout(500)
                        break
                    await page.wait_for_timeout(300)
                
                # Extract job details from right panel
                job_data = await self._extract_job_from_panel(page)
                
                if job_data and job_data.get('apply_urls'):
                    # Deduplicate by first apply URL
                    existing_urls = {j.apply_urls[0].url if j.apply_urls else '' for j in all_jobs}
                    first_url = job_data['apply_urls'][0].url if job_data['apply_urls'] else ''
                    
                    if first_url and first_url not in existing_urls:
                        job = GoogleJob(
                            title=job_data['title'],
                            company=job_data['company'],
                            location=job_data['location'],
                            description=job_data['description'],
                            apply_urls=job_data['apply_urls'],
                            search_query=query,
                            posted_date=job_data.get('postedDate'),
                        )
                        all_jobs.append(job)
                        
                        if len(all_jobs) % 10 == 0:
                            logger.info(f"Collected {len(all_jobs)} jobs...")
            
            # Scroll after processing all new cards
            await page.mouse.move(300, 500)
            await page.mouse.wheel(0, 300)
            await page.wait_for_timeout(500)
        
        logger.info(f"Extraction complete: {len(all_jobs)} jobs collected")
        return all_jobs[:max_jobs]
    
    async def _extract_job_from_panel(self, page) -> Optional[dict]:
        """Extract job details from the right panel after clicking a job card."""
        job_data = await page.evaluate('''() => {
            const items = [];
            // Get viewport width to determine right panel threshold
            const vpWidth = window.innerWidth;
            const rightPanelStart = vpWidth > 1400 ? 700 : 450;
            
            document.querySelectorAll('*').forEach(el => {
                const rect = el.getBoundingClientRect();
                // Right panel area - dynamically adjusted based on viewport
                if (rect.left > rightPanelStart && rect.width > 30 && rect.top > 80 && rect.top < 1200) {
                    const text = (el.innerText || '').trim();
                    const childText = Array.from(el.children).map(c => (c.innerText||'').trim()).join('');
                    const isLeaf = text && (text !== childText || !el.children.length);
                    
                    if (isLeaf && text.length > 0 && text.length < 5000) {
                        items.push({
                            text,
                            top: rect.top,
                            fontSize: parseInt(getComputedStyle(el).fontSize) || 14
                        });
                    }
                }
            });
            items.sort((a, b) => a.top - b.top);
            
            let title = '';
            let company = '';
            let location = '';
            let jobType = '';
            let salary = '';
            let description = '';
            
            // Title - first large text (fontSize >= 20) that isn't "Job description"
            for (const item of items) {
                if (item.fontSize >= 20 && item.text !== 'Job description' && 
                    !item.text.match(/^\\d+\\.?\\d*\\/5$/) && item.text.length > 5 && item.text.length < 150) {
                    title = item.text;
                    break;
                }
            }
            
            // Company/Location - parse "Company • Location • via Source"
            let foundTitle = false;
            for (const item of items) {
                if (item.text === title) {
                    foundTitle = true;
                    continue;
                }
                if (!foundTitle) continue;
                
                if (item.text.includes('•') && item.fontSize === 14) {
                    const parts = item.text.split('•').map(p => p.trim());
                    company = parts[0] || '';
                    
                    // Look for location in remaining parts (skip "via Source")
                    for (let i = 1; i < parts.length; i++) {
                        const part = parts[i];
                        if (part.startsWith('via ')) continue;
                        if (!location) {
                            location = part;
                        }
                    }
                    break;
                }
            }
            
            // Salary - get full salary text including range
            for (const item of items.slice(0, 25)) {
                if (item.text.includes('$')) {
                    const salaryMatch = item.text.match(/\\$[\\d,]+K?(?:\\s*[–-]\\s*\\$[\\d,]+K?)?\\s*(?:a year|an hour|\\/year|\\/hour)?/i);
                    if (salaryMatch) {
                        salary = salaryMatch[0].trim();
                        break;
                    }
                }
            }
            
            // Job type - exact matches
            for (const item of items.slice(0, 30)) {
                const t = item.text.trim();
                if (t === 'Full-time' || t === 'Part-time' || t === 'Contract' || t === 'Internship') {
                    jobType = t;
                    break;
                }
            }
            
            // Posted date - search specifically for date elements in right panel
            // These are small SPAN elements with exact date text
            let postedDate = '';
            document.querySelectorAll('span, div').forEach(el => {
                if (postedDate) return; // Already found
                const text = (el.innerText || '').trim();
                const rect = el.getBoundingClientRect();
                // Must be in right panel, small element, font size 12-14
                if (rect.left > rightPanelStart && rect.top > 200 && rect.top < 500 &&
                    rect.width < 150 && rect.height < 30) {
                    const fontSize = parseInt(getComputedStyle(el).fontSize) || 14;
                    if (fontSize <= 14) {
                        if (text.match(/^\\d+\\s*(hour|day|week|month)s?\\s*ago$/i) ||
                            text === 'Just posted' || text === 'Today' || text === 'Yesterday') {
                            postedDate = text;
                        }
                    }
                }
            });
            
            // Description - longest text block after "Job description" header
            let afterJobDesc = false;
            for (const item of items) {
                if (item.text === 'Job description') {
                    afterJobDesc = true;
                    continue;
                }
                if (afterJobDesc) {
                    if (item.text.length > 150 && 
                        !item.text.includes('Glassdoor') && 
                        !item.text.includes('reviews') &&
                        !item.text.includes('Show full description') &&
                        item.text.length > description.length) {
                        description = item.text;
                    }
                }
            }
            
            // Fallback - if no description found, look for any long text
            if (!description) {
                for (const item of items) {
                    if (item.text.length > 200 && 
                        !item.text.includes('Glassdoor') && 
                        !item.text.includes('reviews') &&
                        !item.text.includes('•') &&
                        item.text.length > description.length) {
                        description = item.text;
                    }
                }
            }
            
            // Apply URLs - extract from right panel
            const applyUrls = [];
            document.querySelectorAll('a[href]').forEach(link => {
                const rect = link.getBoundingClientRect();
                const href = link.href || '';
                if (rect.left > 450 && href.startsWith('http') && 
                    !href.includes('google.com/search') &&
                    !href.includes('support.google') &&
                    !href.includes('policies.google') &&
                    !href.includes('accounts.google') &&
                    !href.includes('/intl/') &&
                    !href.includes('about/products')) {
                    applyUrls.push(href);
                }
            });
            
            return { 
                title, 
                company, 
                location, 
                jobType,
                salary,
                postedDate,
                description: description.substring(0, 3000),
                applyUrls: [...new Set(applyUrls)]
            };
        }''')
        
        if not job_data or not job_data.get('title') or not job_data.get('applyUrls'):
            return None
        
        # Convert to ApplyUrl objects
        apply_urls = []
        for url in job_data['applyUrls']:
            # Extract source from URL domain
            source = "Unknown"
            if 'indeed.com' in url:
                source = "Indeed"
            elif 'linkedin.com' in url:
                source = "LinkedIn"
            elif 'glassdoor' in url:
                source = "Glassdoor"
            elif 'ziprecruiter' in url:
                source = "ZipRecruiter"
            else:
                # Try to extract domain as source
                import re
                domain_match = re.search(r'https?://(?:www\.)?([^/]+)', url)
                if domain_match:
                    source = domain_match.group(1).split('.')[0].title()
            
            apply_urls.append(ApplyUrl(url=url, source=source))
        
        return {
            'title': job_data['title'],
            'company': job_data['company'] or 'Unknown',
            'location': job_data['location'] or '',
            'description': job_data['description'] or '',
            'apply_urls': apply_urls,
            'postedDate': job_data.get('postedDate') or None,
        }



# FastAPI endpoint handler (called from main.py)
async def scrape_google_jobs(
    query: str,
    location: str,
    max_jobs: int = 10000,  # High default - scroll until no more jobs
    date_posted: str = "month",  # today, 3days, week, month, or all
    countries: list[str] = None,
) -> list[dict]:
    """
    API handler for Google Jobs scraping.
    
    Args:
        query: Job search query
        location: Location to search in
        max_jobs: Maximum jobs to return (default 10000 - effectively unlimited)
        date_posted: Date filter - today, 3days, week, month, or all
        countries: Proxy country filter for residential IPs
    
    Returns list of jobs with all apply URLs.
    """
    proxy = DataImpulseProxy(countries=countries) if countries else None
    scraper = GoogleJobsScraper(proxy_provider=proxy)
    
    jobs = await scraper.scrape(query, location, max_jobs=max_jobs, date_posted=date_posted)
    
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
            'posted_date': job.posted_date,
        }
        for job in jobs
    ]
