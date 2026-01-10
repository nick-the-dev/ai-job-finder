/**
 * Backfill Langfuse traces with input/output from their observations
 *
 * This script finds traces that have null input/output and updates them
 * with the data from their nested observations (generations).
 *
 * Run with: npx tsx scripts/backfill-langfuse-traces.ts
 */

import axios from 'axios';
import https from 'https';

const LANGFUSE_BASE_URL = 'https://langfuse.49-12-207-132.sslip.io';
const PUBLIC_KEY = 'pk-lf-f12448d3-281d-4f9d-9f2a-95745cae9cf8';
const SECRET_KEY = 'sk-lf-4a629403-1064-4e42-8659-8cd707bfeb63';

const auth = {
  username: PUBLIC_KEY,
  password: SECRET_KEY,
};

const agent = new https.Agent({ rejectUnauthorized: false });

interface Trace {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  observations: string[];
}

interface Observation {
  id: string;
  traceId: string;
  input: unknown;
  output: unknown;
}

async function getTracesWithEmptyInput(page: number = 1, limit: number = 50): Promise<{ traces: Trace[]; totalPages: number }> {
  const response = await axios.get(`${LANGFUSE_BASE_URL}/api/public/traces`, {
    auth,
    params: { page, limit },
    httpsAgent: agent,
  });

  // Filter to traces that have null input
  const emptyTraces = response.data.data.filter((t: Trace) => t.input === null);
  return {
    traces: emptyTraces,
    totalPages: response.data.meta.totalPages,
  };
}

async function getObservation(observationId: string): Promise<Observation | null> {
  try {
    const response = await axios.get(`${LANGFUSE_BASE_URL}/api/public/observations/${observationId}`, {
      auth,
      httpsAgent: agent,
    });
    return response.data;
  } catch (error) {
    console.error(`Failed to get observation ${observationId}:`, error);
    return null;
  }
}

async function updateTrace(traceId: string, input: unknown, output: unknown): Promise<boolean> {
  try {
    // Langfuse API uses PATCH to update traces
    // The ingestion API expects a specific format
    const body = {
      batch: [{
        id: traceId,
        type: 'trace-create' as const,
        timestamp: new Date().toISOString(),
        body: {
          id: traceId,
          input,
          output,
        },
      }],
    };

    await axios.post(`${LANGFUSE_BASE_URL}/api/public/ingestion`, body, {
      auth,
      httpsAgent: agent,
    });
    return true;
  } catch (error: any) {
    console.error(`Failed to update trace ${traceId}:`, error.response?.data || error.message);
    return false;
  }
}

async function main() {
  console.log('Starting Langfuse trace backfill...\n');

  let page = 1;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  // Process up to 20 pages (1000 traces)
  const maxPages = 20;

  while (page <= maxPages) {
    const { traces, totalPages } = await getTracesWithEmptyInput(page, 50);

    if (traces.length === 0) {
      console.log(`Page ${page}: No empty traces found`);
      page++;
      continue;
    }

    console.log(`Page ${page}/${Math.min(maxPages, totalPages)}: Found ${traces.length} traces with empty input`);

    for (const trace of traces) {
      // Skip traces without observations
      if (!trace.observations || trace.observations.length === 0) {
        console.log(`  Trace ${trace.id}: No observations, skipping`);
        totalSkipped++;
        continue;
      }

      // Get the first observation to extract input/output
      const observation = await getObservation(trace.observations[0]);

      if (!observation) {
        console.log(`  Trace ${trace.id}: Could not fetch observation, skipping`);
        totalSkipped++;
        continue;
      }

      // Skip if observation also has no input
      if (!observation.input) {
        console.log(`  Trace ${trace.id}: Observation has no input, skipping`);
        totalSkipped++;
        continue;
      }

      // Update the trace with input/output from observation
      const success = await updateTrace(trace.id, observation.input, observation.output);

      if (success) {
        console.log(`  Trace ${trace.id}: Updated with input/output from observation`);
        totalUpdated++;
      } else {
        console.log(`  Trace ${trace.id}: Failed to update`);
        totalFailed++;
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    page++;
  }

  console.log('\n--- Summary ---');
  console.log(`Total updated: ${totalUpdated}`);
  console.log(`Total skipped: ${totalSkipped}`);
  console.log(`Total failed: ${totalFailed}`);
}

main().catch(console.error);
