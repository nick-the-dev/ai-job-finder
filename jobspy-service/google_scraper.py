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
        """Extract jobs by clicking on each job card to get apply URLs."""
        all_jobs: list[GoogleJob] = []
        processed_indices: set[int] = set()
        scroll_attempts = 0
        max_scroll_attempts = 10
        no_new_jobs_count = 0

        while len(all_jobs) < max_jobs and scroll_attempts < max_scroll_attempts:
            # Use JavaScript to find job cards dynamically - more robust than CSS selectors
            job_cards_info = await page.evaluate("""
                () => {
                    // Google Jobs uses a list structure - find clickable job items
                    const cards = [];

                    // Try multiple potential container selectors
                    const containers = [
                        document.querySelector('[role="list"]'),
                        document.querySelector('ul'),
                        document.querySelector('.gws-plugins-horizon-jobs__tl-lvc'),
                    ].filter(Boolean);

                    for (const container of containers) {
                        const items = container.querySelectorAll('li, [role="listitem"]');
                        for (let i = 0; i < items.length; i++) {
                            const item = items[i];
                            const text = item.innerText || '';
                            // Check if this looks like a job listing (has reasonable length)
                            if (text.length > 20 && text.length < 1000) {
                                const lines = text.split('\\n').filter(l => l.trim());
                                if (lines.length >= 2) {
                                    cards.push({
                                        index: i,
                                        title: lines[0].trim().substring(0, 200),
                                        company: lines[1].trim().substring(0, 100),
                                        hasContent: true,
                                    });
                                }
                            }
                        }
                        if (cards.length > 0) break;  // Use first container that has cards
                    }
                    return cards;
                }
            """)

            if not job_cards_info:
                logger.warning("No job cards found on page")
                break

            added_this_round = 0

            for card_info in job_cards_info:
                if len(all_jobs) >= max_jobs:
                    break

                idx = card_info['index']
                if idx in processed_indices:
                    continue
                processed_indices.add(idx)

                try:
                    # Click on the card using JavaScript (more reliable)
                    clicked = await page.evaluate("""
                        (cardIndex) => {
                            const containers = [
                                document.querySelector('[role="list"]'),
                                document.querySelector('ul'),
                                document.querySelector('.gws-plugins-horizon-jobs__tl-lvc'),
                            ].filter(Boolean);

                            for (const container of containers) {
                                const items = container.querySelectorAll('li, [role="listitem"]');
                                if (items[cardIndex]) {
                                    items[cardIndex].click();
                                    return true;
                                }
                            }
                            return false;
                        }
                    """, idx)

                    if not clicked:
                        continue

                    await page.wait_for_timeout(800)

                    # Extract job details and apply URLs from the page after click
                    job = await self._extract_job_after_click(page, query, card_info)

                    if job:
                        all_jobs.append(job)
                        added_this_round += 1
                        logger.debug(f"Extracted job: {job.title} @ {job.company} ({len(job.apply_urls)} apply URLs)")

                except Exception as e:
                    logger.debug(f"Error extracting job card {idx}: {str(e)[:100]}")
                    continue

            if added_this_round == 0:
                no_new_jobs_count += 1
                if no_new_jobs_count >= 2:
                    break
            else:
                no_new_jobs_count = 0

            # Scroll to load more jobs
            scroll_attempts += 1
            await page.evaluate("""
                const containers = [
                    document.querySelector('.gws-plugins-horizon-jobs__tl-lvc'),
                    document.querySelector('[role="list"]'),
                    document.querySelector('ul'),
                ].filter(Boolean);
                containers.forEach(c => c.scrollTop = c.scrollHeight);
                window.scrollTo(0, document.body.scrollHeight);
            """)
            await page.wait_for_timeout(1500)

        logger.info(f"Extracted {len(all_jobs)} jobs from Google Jobs (with apply URLs)")
        return all_jobs[:max_jobs]

    async def _extract_job_after_click(self, page, query: str, card_info: dict) -> Optional[GoogleJob]:
        """Extract job details and apply URLs after clicking on a job card."""
        try:
            # Get the HTML after clicking - it now contains the selected job's apply URLs
            html = await page.content()

            # Extract apply URLs using regex (most reliable method)
            apply_urls = self._extract_apply_urls_from_html(html)

            # Try to get more job details from the detail panel using JavaScript
            job_details = await page.evaluate("""
                () => {
                    // Find the detail panel (right side of Google Jobs)
                    const selectors = [
                        '[data-async-context]',
                        '#job-details',
                        '[jsname="bN97Pc"]',
                    ];

                    let panel = null;
                    for (const sel of selectors) {
                        panel = document.querySelector(sel);
                        if (panel && panel.innerText.length > 100) break;
                    }

                    // Fallback: find the largest content block on right side
                    if (!panel) {
                        const allDivs = document.querySelectorAll('div');
                        let maxLen = 0;
                        for (const div of allDivs) {
                            const rect = div.getBoundingClientRect();
                            // Look for divs on the right side of the page
                            if (rect.left > window.innerWidth / 2 && div.innerText.length > maxLen) {
                                maxLen = div.innerText.length;
                                panel = div;
                            }
                        }
                    }

                    if (!panel) return null;

                    const text = panel.innerText || '';
                    const lines = text.split('\\n').filter(l => l.trim());

                    // Try to find title (usually an h2)
                    const h2 = panel.querySelector('h2');
                    const title = h2 ? h2.innerText.trim() : (lines[0] || '');

                    // Description is usually the longest block of text
                    let description = '';
                    for (const line of lines) {
                        if (line.length > 200) {
                            description = line;
                            break;
                        }
                    }

                    // Location usually contains city/state or "Remote"
                    let location = '';
                    for (const line of lines.slice(0, 10)) {
                        if (line.match(/remote|hybrid|on-site|,\s*[A-Z]{2}|canada|usa|united states/i)) {
                            location = line;
                            break;
                        }
                    }

                    return {
                        title: title.substring(0, 200),
                        description: description.substring(0, 5000),
                        location: location.substring(0, 200),
                    };
                }
            """)

            # Use card info as fallback
            title = card_info.get('title', 'Unknown Title')
            company = card_info.get('company', 'Unknown Company')
            location = ''
            description = None

            if job_details:
                if job_details.get('title'):
                    title = job_details['title']
                if job_details.get('location'):
                    location = job_details['location']
                if job_details.get('description'):
                    description = job_details['description']

            return GoogleJob(
                title=title,
                company=company,
                location=location,
                description=description,
                apply_urls=apply_urls,
                search_query=query,
            )
        except Exception as e:
            logger.debug(f"Error extracting job detail: {str(e)[:100]}")
            return None

    def _extract_apply_urls_from_html(self, html: str) -> list[ApplyUrl]:
        """
        Extract apply URLs from HTML using regex.

        This is the most reliable method as it doesn't depend on DOM structure.
        After clicking a job card, its apply URLs are loaded into the page HTML.
        """
        apply_urls: list[ApplyUrl] = []
        seen_urls: set[str] = set()

        # Pattern 1: Google Jobs apply redirect URLs with source info
        # Format: ["https://...google_jobs_apply...", "domain", "Source Name"]
        pattern1 = r'\["(https://[^"]+google_jobs_apply[^"]+)","[^"]*","([^"]+)"'
        for match in re.finditer(pattern1, html):
            url = match.group(1)
            source = match.group(2)
            url = self._clean_url(url)
            if url not in seen_urls:
                seen_urls.add(url)
                apply_urls.append(ApplyUrl(url=url, source=source))

        # Pattern 2: Direct apply links in href attributes
        pattern2 = r'href="(https://www\.google\.com/search\?[^"]*(?:ibp=htl;jobs|google_jobs_apply)[^"]*)"'
        for match in re.finditer(pattern2, html):
            url = self._clean_url(match.group(1))
            if url not in seen_urls:
                seen_urls.add(url)
                apply_urls.append(ApplyUrl(url=url, source='Apply'))

        # Pattern 3: Apply URLs in data attributes or JSON
        pattern3 = r'(https://www\.google\.com/search\?[^"\'>\s]*google_jobs_apply[^"\'>\s]*)'
        for match in re.finditer(pattern3, html):
            url = self._clean_url(match.group(1))
            if url not in seen_urls:
                seen_urls.add(url)
                apply_urls.append(ApplyUrl(url=url, source='Apply'))

        return apply_urls

    def _clean_url(self, url: str) -> str:
        """Clean URL escapes and encoding."""
        url = url.replace('\\u003d', '=').replace('\\u0026', '&')
        url = url.replace('&amp;', '&').replace('\\/', '/')
        return url


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
