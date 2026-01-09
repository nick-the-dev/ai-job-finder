/**
 * Stress test for LLM matching to find optimal concurrency.
 * Tests parallel OpenRouter calls to identify rate limits.
 *
 * Usage: npx tsx scripts/stress-test-llm.ts [concurrency] [totalCalls]
 */

import { config } from '../src/config.js';

// Use native fetch from Node 18+ or fallback
const fetchFn = globalThis.fetch || (await import('node-fetch').then(m => m.default));

const CONCURRENCY = parseInt(process.argv[2]) || 10;
const TOTAL_CALLS = parseInt(process.argv[3]) || 20;

interface TestResult {
  callId: number;
  success: boolean;
  duration: number;
  error?: string;
  rateLimit?: boolean;
}

const sampleJob = {
  title: "Senior Backend Engineer",
  company: "Tech Corp",
  description: "We are looking for a senior backend engineer with experience in Node.js, Python, and cloud services. You will build scalable APIs and microservices.",
  location: "Remote",
};

const sampleResume = "Senior software engineer with 8 years of experience in Python, Node.js, TypeScript, PostgreSQL, AWS. Built microservices handling millions of requests.";

async function callOpenRouter(callId: number): Promise<TestResult> {
  const start = Date.now();

  try {
    const response = await fetchFn('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://ai-job-finder.local',
      },
      body: JSON.stringify({
        model: config.OPENROUTER_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are a job matching assistant. Return JSON with score (1-100) and brief reasoning.',
          },
          {
            role: 'user',
            content: `Rate this job match:\n\nJob: ${sampleJob.title} at ${sampleJob.company}\nDescription: ${sampleJob.description}\n\nResume: ${sampleResume}\n\nReturn JSON: {"score": number, "reasoning": "brief text"}`,
          },
        ],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });

    const duration = Date.now() - start;

    if (!response.ok) {
      const text = await response.text();
      const isRateLimit = response.status === 429 || text.includes('rate') || text.includes('limit');
      return {
        callId,
        success: false,
        duration,
        error: `HTTP ${response.status}: ${text.slice(0, 100)}`,
        rateLimit: isRateLimit,
      };
    }

    await response.json(); // consume response
    return { callId, success: true, duration };
  } catch (error) {
    const duration = Date.now() - start;
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      callId,
      success: false,
      duration,
      error: errorMsg,
      rateLimit: errorMsg.includes('rate') || errorMsg.includes('limit'),
    };
  }
}

async function runBatch(startId: number, count: number): Promise<TestResult[]> {
  const promises = Array.from({ length: count }, (_, i) => callOpenRouter(startId + i));
  return Promise.all(promises);
}

async function main() {
  console.log(`\n🚀 LLM Stress Test`);
  console.log(`   Model: ${config.OPENROUTER_MODEL}`);
  console.log(`   Concurrency: ${CONCURRENCY} parallel calls`);
  console.log(`   Total calls: ${TOTAL_CALLS}`);
  console.log(`   Batches: ${Math.ceil(TOTAL_CALLS / CONCURRENCY)}\n`);

  const allResults: TestResult[] = [];
  let callId = 1;
  let rateLimitHit = false;

  const overallStart = Date.now();

  while (callId <= TOTAL_CALLS && !rateLimitHit) {
    const batchSize = Math.min(CONCURRENCY, TOTAL_CALLS - callId + 1);
    const batchNum = Math.ceil(callId / CONCURRENCY);

    console.log(`📦 Batch ${batchNum}: ${batchSize} parallel calls (${callId}-${callId + batchSize - 1})...`);

    const batchStart = Date.now();
    const results = await runBatch(callId, batchSize);
    const batchDuration = Date.now() - batchStart;

    const successes = results.filter(r => r.success).length;
    const failures = results.filter(r => !r.success).length;
    const rateLimits = results.filter(r => r.rateLimit).length;
    const avgDuration = Math.round(results.reduce((sum, r) => sum + r.duration, 0) / results.length);

    console.log(`   ✅ ${successes} success | ❌ ${failures} failed | ⏱️ ${batchDuration}ms total | ~${avgDuration}ms avg`);

    if (rateLimits > 0) {
      console.log(`   🚫 ${rateLimits} RATE LIMIT(S) DETECTED!`);
      rateLimitHit = true;
    }

    // Log any errors
    results.filter(r => r.error).forEach(r => {
      console.log(`   → Call #${r.callId}: ${r.error?.slice(0, 80)}`);
    });

    allResults.push(...results);
    callId += batchSize;

    // Small delay between batches to be slightly gentle
    if (callId <= TOTAL_CALLS && !rateLimitHit) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  const overallDuration = Date.now() - overallStart;

  // Summary
  console.log(`\n📊 RESULTS SUMMARY`);
  console.log(`   Total calls: ${allResults.length}`);
  console.log(`   Successful: ${allResults.filter(r => r.success).length}`);
  console.log(`   Failed: ${allResults.filter(r => !r.success).length}`);
  console.log(`   Rate limits: ${allResults.filter(r => r.rateLimit).length}`);
  console.log(`   Total time: ${(overallDuration / 1000).toFixed(1)}s`);
  console.log(`   Throughput: ${(allResults.filter(r => r.success).length / (overallDuration / 1000)).toFixed(1)} calls/sec`);

  const successDurations = allResults.filter(r => r.success).map(r => r.duration);
  if (successDurations.length > 0) {
    console.log(`   Avg latency: ${Math.round(successDurations.reduce((a, b) => a + b, 0) / successDurations.length)}ms`);
    console.log(`   Min latency: ${Math.min(...successDurations)}ms`);
    console.log(`   Max latency: ${Math.max(...successDurations)}ms`);
  }

  if (rateLimitHit) {
    console.log(`\n⚠️  Rate limit reached at concurrency ${CONCURRENCY}. Try lower value.`);
  } else {
    console.log(`\n✅ No rate limits at concurrency ${CONCURRENCY}. Can try higher!`);
  }
}

main().catch(console.error);
