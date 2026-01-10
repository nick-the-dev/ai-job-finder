"""
Proxy pool management for JobSpy scraper.

Manages a rotating pool of proxies loaded from environment variables.
Supports round-robin rotation and random selection.
"""

import os
import logging
from typing import Optional, List
from threading import Lock
import random

logger = logging.getLogger(__name__)


class ProxyPool:
    """
    Proxy pool for managing multiple proxy instances.

    Loads proxies from JOBSPY_PROXIES environment variable (comma-separated).
    Format: http://USERNAME:PASSWORD@host:port,http://USERNAME:PASSWORD@host2:port2,...

    Features:
    - Round-robin rotation via get_next()
    - Random selection via get_random()
    - Thread-safe operations
    - Handles empty proxy list gracefully
    """

    def __init__(self):
        """Initialize the proxy pool from environment variable."""
        self._proxies: List[str] = []
        self._current_index: int = 0
        self._lock = Lock()

        # Load proxies from environment variable
        proxies_str = os.environ.get("JOBSPY_PROXIES", "")
        if proxies_str:
            # Split by comma and strip whitespace
            self._proxies = [proxy.strip() for proxy in proxies_str.split(",") if proxy.strip()]

        if self._proxies:
            logger.info(f"ProxyPool initialized with {len(self._proxies)} proxies")
        else:
            logger.info("ProxyPool initialized with no proxies (direct connection)")

    @property
    def size(self) -> int:
        """Return the number of proxies in the pool."""
        return len(self._proxies)

    def get_next(self) -> Optional[str]:
        """
        Get the next proxy using round-robin rotation.

        Thread-safe operation that cycles through proxies in order.

        Returns:
            str: Next proxy URL, or None if pool is empty
        """
        if not self._proxies:
            return None

        with self._lock:
            proxy = self._proxies[self._current_index]
            self._current_index = (self._current_index + 1) % len(self._proxies)
            return proxy

    def get_random(self) -> Optional[str]:
        """
        Get a random proxy from the pool.

        Returns:
            str: Random proxy URL, or None if pool is empty
        """
        if not self._proxies:
            return None

        return random.choice(self._proxies)

    def get_all(self) -> List[str]:
        """
        Get all proxies in the pool.

        Returns:
            List[str]: List of all proxy URLs
        """
        return self._proxies.copy()

    def mask_proxy(self, proxy: str) -> str:
        """
        Mask proxy credentials for safe logging.

        Replaces username:password with ***:*** in proxy URL.

        Args:
            proxy: Proxy URL (e.g., http://USERNAME:PASSWORD@host:port)

        Returns:
            str: Masked proxy URL (e.g., http://***:***@host:port)
        """
        if not proxy or "@" not in proxy:
            return proxy

        # Split by @ to separate credentials from host
        parts = proxy.split("@")
        if len(parts) != 2:
            return proxy

        # Split credentials part by :// to get protocol
        cred_parts = parts[0].split("://")
        if len(cred_parts) != 2:
            return proxy

        protocol = cred_parts[0]
        host = parts[1]

        # Return masked version
        return f"{protocol}://***:***@{host}"
