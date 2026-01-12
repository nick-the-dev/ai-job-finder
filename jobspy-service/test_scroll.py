import asyncio
import random

async def test():
    from camoufox.async_api import AsyncCamoufox
    from urllib.parse import quote_plus
    
    query = "software engineer"
    location = "Toronto"
    search_query = quote_plus(f"{query} {location}")
    url = f"https://www.google.com/search?q={search_query}&ibp=htl;jobs&hl=en"
    
    print(f"Opening: {url}")
    
    async with AsyncCamoufox(headless=True) as browser:
        context = await browser.new_context()
        page = await context.new_page()
        
        await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(3000)
        
        content = await page.content()
        print(f"Initial page size: {len(content)} bytes")
        
        # Find job list items
        job_items = await page.query_selector_all('li[data-ved]')
        print(f"Found {len(job_items)} job items with li[data-ved]")
        
        job_items2 = await page.query_selector_all('div[role="treeitem"]')
        print(f"Found {len(job_items2)} job items with div[role=treeitem]")
        
        job_items3 = await page.query_selector_all('.iFjolb')
        print(f"Found {len(job_items3)} job items with .iFjolb")
        
        job_items4 = await page.query_selector_all('[jsname="mUpfKd"]')
        print(f"Found {len(job_items4)} job items with [jsname=mUpfKd]")
        
        # Try different scroll containers
        scroll_result = await page.evaluate("""
            () => {
                const results = [];
                
                // Find the job list container
                const selectors = [
                    '.gws-plugins-horizon-jobs__tl-lvc',
                    'div[role="tree"]',
                    'div[role="list"]',
                    '.jobs-list',
                    '#search',
                    'ul[role="listbox"]'
                ];
                
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el) {
                        results.push({
                            selector: sel,
                            scrollHeight: el.scrollHeight,
                            clientHeight: el.clientHeight,
                            childCount: el.children.length
                        });
                    }
                }
                
                return results;
            }
        """)
        print(f"Scroll containers found: {scroll_result}")
        
        # Try scrolling the tree container
        print("\nScrolling div[role=tree]...")
        for i in range(5):
            before = len(await page.query_selector_all('li[data-ved]'))
            
            await page.evaluate("""
                () => {
                    const tree = document.querySelector('div[role="tree"]');
                    if (tree) {
                        tree.scrollTop = tree.scrollHeight;
                    }
                }
            """)
            await page.wait_for_timeout(2000)
            
            after = len(await page.query_selector_all('li[data-ved]'))
            print(f"  Scroll {i+1}: {before} -> {after} items")

asyncio.run(test())
