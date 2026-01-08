import axios from 'axios';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Retry configuration
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Request timeout (60 seconds should be enough for any LLM call)
const REQUEST_TIMEOUT_MS = 60000;

interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  maxRetries?: number;
  timeout?: number;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Strip JavaScript-style comments from JSON string
 * LLMs sometimes add comments even when told not to
 */
function stripJsonComments(json: string): string {
  // Remove single-line comments (// ...) but not inside strings
  // This is a simplified approach that handles most cases
  return json.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (match, stringLiteral) => {
    // If it's a string literal, keep it as-is
    if (stringLiteral) return stringLiteral;
    // Otherwise it's a comment, remove it
    return '';
  });
}

/**
 * Calculate exponential backoff delay with jitter
 */
function getBackoffDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter) {
    return retryAfter * 1000; // Convert to ms
  }
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s (capped at MAX_DELAY_MS)
  const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 500; // Add 0-500ms jitter
  return Math.min(exponentialDelay + jitter, MAX_DELAY_MS);
}

/**
 * OpenRouter LLM client with structured output support
 * Includes exponential backoff for rate limiting (429 errors)
 */
export async function callLLM<T>(
  messages: Message[],
  schema: z.ZodSchema<T>,
  jsonSchema: object,
  options: LLMOptions = {}
): Promise<T> {
  const { temperature = 0.1, maxTokens = 2000, maxRetries = MAX_RETRIES, timeout = REQUEST_TIMEOUT_MS } = options;

  // Add instruction to respond with JSON
  const lastMessage = messages[messages.length - 1];
  const enhancedMessages = [
    ...messages.slice(0, -1),
    {
      ...lastMessage,
      content: `${lastMessage.content}

Respond ONLY with a valid JSON object. No other text.`,
    },
  ];

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        logger.info('LLM', `Retry attempt ${attempt}/${maxRetries}...`);
      }

      const response = await axios.post(
        OPENROUTER_URL,
        {
          model: config.OPENROUTER_MODEL,
          messages: enhancedMessages,
          temperature,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
        },
        {
          headers: {
            'Authorization': `Bearer ${config.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/ai-job-finder',
            'X-Title': 'AI Job Finder',
          },
          timeout, // Prevent hanging on slow/stuck API calls
        }
      );

      const content = response.data.choices?.[0]?.message?.content;
      if (!content) {
        // Empty/malformed response - could be transient, so retry
        if (attempt < maxRetries) {
          const delay = getBackoffDelay(attempt);
          logger.warn('LLM', `Empty/malformed response, waiting ${Math.round(delay / 1000)}s before retry...`, {
            hasChoices: !!response.data.choices,
            choicesLength: response.data.choices?.length,
            responseKeys: Object.keys(response.data || {}),
          });
          await sleep(delay);
          lastError = new Error('Empty response from LLM');
          continue;
        }
        throw new Error('Empty response from LLM after all retries');
      }

      // Parse JSON (strip comments first - LLMs sometimes add them)
      let parsed: unknown;
      try {
        const cleanedContent = stripJsonComments(content);
        parsed = JSON.parse(cleanedContent);
      } catch (e) {
        logger.error('LLM', 'Failed to parse JSON response', content);
        throw new Error('Invalid JSON from LLM');
      }

      // Validate with Zod
      const result = schema.safeParse(parsed);
      if (!result.success) {
        logger.error('LLM', 'Schema validation failed', result.error.format());
        throw new Error(`Schema validation failed: ${result.error.message}`);
      }

      return result.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const retryAfter = error.response?.headers?.['retry-after'];
        const isTimeout = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';

        // Retry on timeout, rate limit (429), or server errors (5xx)
        if (isTimeout || status === 429 || (status && status >= 500)) {
          if (attempt < maxRetries) {
            const delay = getBackoffDelay(attempt, retryAfter ? parseInt(retryAfter) : undefined);
            const reason = isTimeout ? 'timeout' : `status ${status}`;
            logger.warn('LLM', `Request failed (${reason}), waiting ${Math.round(delay / 1000)}s before retry...`);
            await sleep(delay);
            lastError = new Error(`LLM API error: ${reason}`);
            continue;
          }
        }

        logger.error('LLM', 'API error', {
          status,
          code: error.code,
          data: error.response?.data,
        });
        throw new Error(`LLM API error: ${isTimeout ? 'timeout' : status}`);
      }
      throw error;
    }
  }

  // All retries exhausted
  throw lastError || new Error('LLM request failed after all retries');
}
