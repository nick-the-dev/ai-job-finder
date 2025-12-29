import axios from 'axios';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
}

/**
 * OpenRouter LLM client with structured output support
 * Note: For models that don't support json_schema response_format,
 * we embed the schema in the prompt instead.
 */
export async function callLLM<T>(
  messages: Message[],
  schema: z.ZodSchema<T>,
  jsonSchema: object,
  options: LLMOptions = {}
): Promise<T> {
  const { temperature = 0.1, maxTokens = 2000 } = options;

  logger.info('LLM', `Calling ${config.OPENROUTER_MODEL}...`);
  logger.debug('LLM', 'Messages', { count: messages.length });

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

  try {
    const response = await axios.post(
      OPENROUTER_URL,
      {
        model: config.OPENROUTER_MODEL,
        messages: enhancedMessages,
        temperature,
        max_tokens: maxTokens,
        // Note: json_object response_format not supported by all models
        // We use prompt engineering to get JSON responses instead
      },
      {
        headers: {
          'Authorization': `Bearer ${config.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/ai-job-finder',
          'X-Title': 'AI Job Finder',
        },
      }
    );

    const content = response.data.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from LLM');
    }

    logger.debug('LLM', 'Raw response', content.substring(0, 300));

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
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

    logger.info('LLM', 'Response validated successfully');
    return result.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      logger.error('LLM', 'API error', {
        status: error.response?.status,
        data: error.response?.data,
      });
      throw new Error(`LLM API error: ${error.response?.status}`);
    }
    throw error;
  }
}
