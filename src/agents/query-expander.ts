import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { callLLM } from '../llm/client.js';
import { QueryExpansionSchema, QueryExpansionJsonSchema, type QueryExpansionOutput } from '../schemas/llm-outputs.js';
import { getDb } from '../db/client.js';
import type { IAgent } from '../core/interfaces.js';

export interface QueryExpanderInput {
  jobTitles: string[];
  resumeText: string;
}

export interface QueryExpanderOutput {
  allTitles: string[];       // Combined & deduped
  fromExpansion: string[];   // For transparency
  fromResume: string[];      // For transparency
}

/**
 * QueryExpanderAgent - uses LLM to expand job titles and suggest additional titles based on resume
 */
export class QueryExpanderAgent implements IAgent<QueryExpanderInput, QueryExpanderOutput> {
  /**
   * Compute cache key from job titles and resume snippet
   */
  private computeCacheKey(jobTitles: string[], resumeText: string): string {
    const normalized = jobTitles.map(t => t.toLowerCase().trim()).sort().join('|');
    const resumeSnippet = resumeText.slice(0, 500).toLowerCase().trim();
    const combined = `${normalized}::${resumeSnippet}`;
    return crypto.createHash('sha256').update(combined).digest('hex').slice(0, 32);
  }

  async execute(input: QueryExpanderInput): Promise<QueryExpanderOutput> {
    const { jobTitles, resumeText } = input;

    logger.info('QueryExpander', `Expanding ${jobTitles.length} job titles...`);

    // 1. Check cache first
    const cacheKey = this.computeCacheKey(jobTitles, resumeText);
    const db = getDb();

    const cached = await db.queryExpansion.findUnique({
      where: { cacheKey },
    });

    if (cached) {
      logger.info('QueryExpander', 'Using cached expansion');
      const allTitles = [...new Set([...cached.expandedQueries, ...cached.resumeSuggested])];
      return {
        allTitles,
        fromExpansion: cached.expandedQueries,
        fromResume: cached.resumeSuggested,
      };
    }

    // 2. Call LLM for expansion
    const maxExpanded = jobTitles.length * 2; // Original + 1 synonym each
    const systemPrompt = `You are a job search expert. Your task is to expand job search queries to find more relevant positions.

You MUST respond with a JSON object containing these exact fields:
- expandedQueries: array of job titles (max ${maxExpanded} total - original titles + 1 synonym each)
- resumeSuggestedTitles: array of additional job titles based on resume skills (max 5)

CRITICAL RULE for expandedQueries:
- Include each original job title exactly as given
- Add exactly 1 related ROLE/FUNCTION synonym per original title (not more)
- ONLY expand with synonymous job ROLES, NOT with technology/tool names
- The expansion should work for ANY job title - keep it about the ROLE, not the tech stack

Examples of CORRECT expansions (1 synonym per title):
- "Backend Engineer" → "Backend Developer" (just 1 synonym)
- "Data Scientist" → "ML Engineer" (just 1 synonym)
- "DevOps Engineer" → "Platform Engineer" (just 1 synonym)
- "Frontend Developer" → "UI Developer" (just 1 synonym)

Examples of WRONG expansions:
- "Backend Engineer" → "Python Developer" ❌ (tech-specific, not in original)
- "Backend Engineer" → "Backend Developer", "API Engineer", "Server Engineer" ❌ (too many - only 1 allowed)

For resumeSuggestedTitles (max 5):
- Analyze the resume skills and experience level
- Suggest up to 5 job titles the candidate would be qualified for
- These CAN include technology-specific titles if the resume explicitly shows that expertise
- Consider seniority level (Senior, Lead, Staff, Principal) based on years of experience
- Don't repeat titles already in expandedQueries`;

    const userPrompt = `Original job titles: ${jobTitles.join(', ')}

Resume:
${resumeText.slice(0, 3000)}

Generate expanded job titles and resume-based suggestions in the required JSON format.`;

    try {
      const result = await callLLM<QueryExpansionOutput>(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        QueryExpansionSchema,
        QueryExpansionJsonSchema
      );

      logger.info('QueryExpander', `Generated ${result.expandedQueries.length} expanded + ${result.resumeSuggestedTitles.length} resume-based titles`);

      // 3. Cache result
      await db.queryExpansion.create({
        data: {
          cacheKey,
          originalQueries: jobTitles,
          expandedQueries: result.expandedQueries,
          resumeSuggested: result.resumeSuggestedTitles,
        },
      });

      const allTitles = [...new Set([...result.expandedQueries, ...result.resumeSuggestedTitles])];
      return {
        allTitles,
        fromExpansion: result.expandedQueries,
        fromResume: result.resumeSuggestedTitles,
      };
    } catch (error) {
      logger.error('QueryExpander', 'Expansion failed', error);
      throw error;
    }
  }
}
