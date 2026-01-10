"""
Tests for ProxyPool class.
"""

import pytest
import os
from proxy_pool import ProxyPool


def test_proxy_pool_empty():
    """Test proxy pool with no proxies configured."""
    # Clear env var
    if "JOBSPY_PROXIES" in os.environ:
        del os.environ["JOBSPY_PROXIES"]

    pool = ProxyPool()
    assert pool.size == 0
    assert pool.get_next() is None
    assert pool.get_random() is None
    assert pool.get_all() == []


def test_proxy_pool_single_proxy():
    """Test proxy pool with a single proxy."""
    os.environ["JOBSPY_PROXIES"] = "http://user:pass@proxy1.com:8080"

    pool = ProxyPool()
    assert pool.size == 1
    assert pool.get_next() == "http://user:pass@proxy1.com:8080"
    assert pool.get_next() == "http://user:pass@proxy1.com:8080"  # Should cycle back
    assert pool.get_random() == "http://user:pass@proxy1.com:8080"


def test_proxy_pool_multiple_proxies():
    """Test proxy pool with multiple proxies."""
    os.environ["JOBSPY_PROXIES"] = "http://user1:pass1@proxy1.com:8080,http://user2:pass2@proxy2.com:8080,http://user3:pass3@proxy3.com:8080"

    pool = ProxyPool()
    assert pool.size == 3

    # Test round-robin rotation
    assert pool.get_next() == "http://user1:pass1@proxy1.com:8080"
    assert pool.get_next() == "http://user2:pass2@proxy2.com:8080"
    assert pool.get_next() == "http://user3:pass3@proxy3.com:8080"
    assert pool.get_next() == "http://user1:pass1@proxy1.com:8080"  # Cycles back

    # Test get_random returns one of the proxies
    random_proxy = pool.get_random()
    assert random_proxy in pool.get_all()


def test_proxy_pool_whitespace_handling():
    """Test proxy pool handles whitespace correctly."""
    os.environ["JOBSPY_PROXIES"] = " http://proxy1.com:8080 , http://proxy2.com:8080 , http://proxy3.com:8080 "

    pool = ProxyPool()
    assert pool.size == 3
    assert all("http://" in proxy for proxy in pool.get_all())
    assert all(" " not in proxy for proxy in pool.get_all())  # No leading/trailing spaces


def test_proxy_pool_empty_entries():
    """Test proxy pool filters out empty entries."""
    os.environ["JOBSPY_PROXIES"] = "http://proxy1.com:8080,,http://proxy2.com:8080,,"

    pool = ProxyPool()
    assert pool.size == 2
    assert pool.get_all() == ["http://proxy1.com:8080", "http://proxy2.com:8080"]


def test_proxy_mask():
    """Test proxy masking for safe logging."""
    pool = ProxyPool()

    # Test with credentials
    masked = pool.mask_proxy("http://user:pass@proxy.com:8080")
    assert masked == "http://***:***@proxy.com:8080"

    # Test without credentials
    masked_no_creds = pool.mask_proxy("http://proxy.com:8080")
    assert masked_no_creds == "http://proxy.com:8080"

    # Test with https
    masked_https = pool.mask_proxy("https://user:pass@proxy.com:8080")
    assert masked_https == "https://***:***@proxy.com:8080"

    # Test edge cases
    assert pool.mask_proxy("") == ""
    assert pool.mask_proxy("invalid") == "invalid"


def test_proxy_pool_get_all_returns_copy():
    """Test that get_all returns a copy, not the original list."""
    os.environ["JOBSPY_PROXIES"] = "http://proxy1.com:8080,http://proxy2.com:8080"

    pool = ProxyPool()
    all_proxies = pool.get_all()
    all_proxies.append("http://malicious.com:8080")

    # Original pool should be unaffected
    assert pool.size == 2
    assert "http://malicious.com:8080" not in pool.get_all()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
