import { z } from 'zod';

/**
 * Schema for extracted salary information
 */
export const ExtractedSalarySchema = z.object({
  min: z.number().nullable().describe('Minimum salary amount (annual or hourly)'),
  max: z.number().nullable().describe('Maximum salary amount (annual or hourly)'),
  currency: z.string().describe('Currency code (USD, EUR, GBP, CAD, AUD)'),
  isHourly: z.boolean().describe('True if this is an hourly rate, false if annual'),
}).nullable();

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

  extractedSalary: ExtractedSalarySchema
    .describe('Salary extracted from job description if not already provided'),
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
    extractedSalary: {
      type: ['object', 'null'],
      properties: {
        min: { type: ['number', 'null'], description: 'Minimum salary amount' },
        max: { type: ['number', 'null'], description: 'Maximum salary amount' },
        currency: { type: 'string', description: 'Currency code (USD, EUR, GBP, CAD, AUD)' },
        isHourly: { type: 'boolean', description: 'True if hourly rate, false if annual' },
      },
      description: 'Salary extracted from job description (null if not found)',
    },
  },
  required: ['score', 'reasoning', 'matchedSkills', 'missingSkills', 'pros', 'cons', 'extractedSalary'],
} as const;

/**
 * Schema for query expansion - structured LLM output
 */
export const QueryExpansionSchema = z.object({
  expandedQueries: z.array(z.string())
    .max(50)
    .describe('Expanded job title variants from original queries'),

  resumeSuggestedTitles: z.array(z.string())
    .max(15)
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
      maxItems: 50,
      description: 'Expanded job title variants from original queries',
    },
    resumeSuggestedTitles: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 15,
      description: 'Additional job titles suggested based on resume skills',
    },
  },
  required: ['expandedQueries', 'resumeSuggestedTitles'],
} as const;
