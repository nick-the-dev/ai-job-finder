# Scalable Infrastructure Guide

This guide covers the high-throughput job scraping infrastructure added to support 100+ proxy instances and parallel LLM processing.

## Overview

This infrastructure enables:
- **100+ concurrent proxy instances** for high-throughput job scraping
- **Multiple API keys** with automatic rate limiting and rotation
- **Parallel workers** for 6-10x faster job collection
- **Fault tolerance** with graceful degradation
- **Backward compatibility** - disabled by default, opt-in activation

## Quick Start

### Basic Configuration

```bash
# JobSpy proxies
export JOBSPY_PROXIES="http://EXAMPLE_USER:EXAMPLE_PASS@proxy1.example.com:8080,http://EXAMPLE_USER:EXAMPLE_PASS@proxy2.example.com:8080"

# OpenRouter API keys
export OPENROUTER_API_KEYS="sk-or-key1,sk-or-key2,sk-or-key3"

# Enable parallel mode
export JOBSPY_PARALLEL_ENABLED=true
export JOBSPY_PARALLEL_WORKERS=10
```

### Expected Performance

**Single-threaded** (disabled):
- 100 jobs → ~30 seconds
- 10 LLM requests/minute

**Parallel** (10 workers, 3 keys):
- 100 jobs → ~5 seconds (6x faster)
- 30 LLM requests/minute (3x higher)

## Components

### 1. JobSpy Proxy Pool

Manages proxy rotation for job scraping.

**Features**:
- Round-robin and random selection
- Thread-safe operation
- Credential masking in logs
- Graceful fallback without proxies

**Configuration**:
```bash
export JOBSPY_PROXIES="http://EXAMPLE_USER:EXAMPLE_PASS@proxy1.example.com:8080,http://EXAMPLE_USER:EXAMPLE_PASS@proxy2.example.com:8080"
```

**Debugging**:
```bash
curl http://localhost:8000/debug/proxies
# {"proxy_count": 2, "proxies_enabled": true}
```

### 2. OpenRouter API Key Pool

Manages multiple API keys with rate limiting.

**Features**:
- Automatic rate limiting (10 RPM per key, configurable)
- 429 error handling (auto-blocks keys)
- Round-robin rotation
- 1-minute sliding window

**Configuration**:
```bash
export OPENROUTER_API_KEYS="sk-or-key1,sk-or-key2,sk-or-key3"
export OPENROUTER_KEY_RATE_LIMIT=10
```

**Total Capacity**: 3 keys × 10 RPM = 30 requests/minute

### 3. Parallel JobSpy Workers

Distributes scraping across multiple workers.

**Features**:
- Configurable concurrency (default: 10)
- Fault tolerance (Promise.allSettled)
- Automatic deduplication
- Smart retry logic
- Success/failure metrics

**Configuration**:
```bash
export JOBSPY_PARALLEL_ENABLED=true
export JOBSPY_PARALLEL_WORKERS=10
```

## Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `JOBSPY_PROXIES` | string | - | Comma-separated proxy URLs |
| `JOBSPY_PARALLEL_ENABLED` | boolean | false | Enable parallel collection |
| `JOBSPY_PARALLEL_WORKERS` | number | 10 | Number of concurrent workers |
| `OPENROUTER_API_KEYS` | string | - | Comma-separated API keys |
| `OPENROUTER_KEY_RATE_LIMIT` | number | 10 | Requests per minute per key |

## Production Setup

**Typical configuration**:
```bash
# 50 proxies
JOBSPY_PROXIES="proxy1,proxy2,...,proxy50"

# 10 parallel workers
JOBSPY_PARALLEL_ENABLED=true
JOBSPY_PARALLEL_WORKERS=10

# 5 API keys
OPENROUTER_API_KEYS="key1,key2,key3,key4,key5"
OPENROUTER_KEY_RATE_LIMIT=10
```

**Throughput**:
- Job collection: 500-1000 jobs/minute
- LLM processing: 50 requests/minute (5 keys × 10 RPM)

## Testing

```bash
# Python tests (proxy pool)
cd jobspy-service
python -m pytest test_proxy_pool.py -v

# TypeScript tests (key pool)
npm test src/llm/key-pool.test.ts

# All tests
npm test
```

## Monitoring

**JobSpy service**:
```bash
curl http://localhost:8000/health
curl http://localhost:8000/debug/proxies
```

**Key pool stats** (in code):
```typescript
import { getKeyPool } from './llm/client.js';
const stats = getKeyPool().getStats();
```

**Logs**:
```
[INFO] [KeyPool] Initialized with 3 keys (rate limit: 10 RPM per key)
[INFO] [ProxyPool] Proxy pool initialized with 10 proxies
[INFO] [ParallelCollector] Workers completed: 9 success, 1 failed
[INFO] [ParallelCollector] Collected 150 jobs, deduplicated to 105, returning 100
```

## Troubleshooting

**"All keys are at rate limit"**:
- Wait 60 seconds for limits to reset
- Add more keys to `OPENROUTER_API_KEYS`
- Reduce `OPENROUTER_KEY_RATE_LIMIT`

**"Workers completed: 0 success, 10 failed"**:
- Check JobSpy service: `curl http://localhost:8000/health`
- Check proxies: `curl http://localhost:8000/debug/proxies`
- Test proxies manually

**Slow performance**:
- Increase `JOBSPY_PARALLEL_WORKERS`
- Use faster/more proxies
- Enable caching (`skipCache: false`)

## Best Practices

1. **Start small**: Test with 1-2 proxies before scaling
2. **Monitor logs**: Watch for failed workers and 429 errors
3. **Gradual scaling**: 5 → 10 → 20 workers
4. **Use caching**: Reduces redundant API calls
5. **Quality proxies**: Use reliable proxies with good uptime

## Architecture

```
CollectorService
  ├─ ParallelCollector (if enabled)
  │   ├─ Worker 1 → JobSpy Service → ProxyPool → proxy1
  │   ├─ Worker 2 → JobSpy Service → ProxyPool → proxy2
  │   └─ Worker N → JobSpy Service → ProxyPool → proxyN
  └─ Single-threaded (if disabled)
      └─ JobSpy Service → ProxyPool → rotating proxies

LLM Client
  └─ OpenRouterKeyPool
      ├─ key1 (8/10 RPM)
      ├─ key2 (5/10 RPM)
      └─ key3 (10/10 RPM, blocked)
```

For detailed documentation, see the full guide in this file.
