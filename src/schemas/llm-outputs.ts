import { z } from 'zod';

/**
 * Schema for job match analysis - structured LLM output
 */
export const JobMatchSchema = z.object({
  score: z.number()
    .int('Score must be an integer')
    .min(1, 'Score must be at least 1')
    .max(100, 'Score must be at most 100')
    .describe('Match score from 1-100'),

  reasoning: z.string()
    .min(10, 'Reasoning must be at least 10 characters')
    .describe('Explanation for the score'),

  matchedSkills: z.array(z.string())
    .describe('Skills from resume that match job requirements'),

  missingSkills: z.array(z.string())
    .describe('Skills required by job but not in resume'),

  pros: z.array(z.string())
    .describe('Positive aspects of this job match'),

  cons: z.array(z.string())
    .describe('Potential concerns or drawbacks'),
});

export type JobMatchOutput = z.infer<typeof JobMatchSchema>;

/**
 * JSON Schema for LLM structured output
 */
export const JobMatchJsonSchema = {
  type: 'object',
  properties: {
    score: {
      type: 'number',
      minimum: 1,
      maximum: 100,
      description: 'Match score from 1-100',
    },
    reasoning: {
      type: 'string',
      description: 'Explanation for the score',
    },
    matchedSkills: {
      type: 'array',
      items: { type: 'string' },
      description: 'Skills from resume that match job requirements',
    },
    missingSkills: {
      type: 'array',
      items: { type: 'string' },
      description: 'Skills required by job but not in resume',
    },
    pros: {
      type: 'array',
      items: { type: 'string' },
      description: 'Positive aspects of this job match',
    },
    cons: {
      type: 'array',
      items: { type: 'string' },
      description: 'Potential concerns or drawbacks',
    },
  },
  required: ['score', 'reasoning', 'matchedSkills', 'missingSkills', 'pros', 'cons'],
} as const;

/**
 * Schema for query expansion - structured LLM output
 */
export const QueryExpansionSchema = z.object({
  expandedQueries: z.array(z.string())
    .max(25)
    .describe('Expanded job title variants from original queries'),

  resumeSuggestedTitles: z.array(z.string())
    .max(10)
    .describe('Additional job titles suggested based on resume skills'),
});

export type QueryExpansionOutput = z.infer<typeof QueryExpansionSchema>;

/**
 * JSON Schema for query expansion LLM structured output
 */
export const QueryExpansionJsonSchema = {
  type: 'object',
  properties: {
    expandedQueries: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 25,
      description: 'Expanded job title variants from original queries',
    },
    resumeSuggestedTitles: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 10,
      description: 'Additional job titles suggested based on resume skills',
    },
  },
  required: ['expandedQueries', 'resumeSuggestedTitles'],
} as const;
