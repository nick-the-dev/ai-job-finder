import { logger } from '../utils/logger.js';
import { callLLM } from '../llm/client.js';
import { JobMatchSchema, JobMatchJsonSchema, type JobMatchOutput } from '../schemas/llm-outputs.js';
import type { NormalizedJob, JobMatchResult } from '../core/types.js';
import type { IAgent, VerifiedOutput } from '../core/interfaces.js';

interface MatcherInput {
  job: NormalizedJob;
  resumeText: string;
}

/**
 * MatcherAgent - uses LLM to analyze job-resume fit
 * Returns score 1-100 with reasoning
 */
export class MatcherAgent implements IAgent<MatcherInput, JobMatchResult> {
  async execute(input: MatcherInput): Promise<JobMatchResult> {
    const { job, resumeText } = input;

    const systemPrompt = `You are a job matching expert. Analyze how well a candidate's resume matches a job posting.

You MUST respond with a valid JSON object only. Do NOT include comments (// or /* */) in your JSON response.

JSON object must contain these exact fields:
- score: number from 1-100 (match score)
- reasoning: string (explanation for the score)
- matchedSkills: array of strings (skills from resume that match job)
- missingSkills: array of strings (skills required by job but not in resume)
- pros: array of strings (positive aspects of this match)
- cons: array of strings (concerns or drawbacks)
- extractedSalary: object or null (salary info extracted from description)
  - If salary is mentioned: { min: number|null, max: number|null, currency: "USD"|"EUR"|"GBP"|"CAD"|"AUD", isHourly: boolean }
  - If no salary info found: null

Example response:
{
  "score": 75,
  "reasoning": "Strong match on backend skills but missing some frontend requirements",
  "matchedSkills": ["Python", "Node.js", "PostgreSQL"],
  "missingSkills": ["Angular", "GraphQL"],
  "pros": ["Great backend experience", "Leadership experience"],
  "cons": ["No Angular experience", "May need frontend training"],
  "extractedSalary": { "min": 120000, "max": 150000, "currency": "USD", "isHourly": false }
}

Score guidelines:
- 90-100: Perfect match
- 70-89: Strong match
- 50-69: Moderate match
- 30-49: Weak match
- 1-29: Poor match

Salary extraction guidelines:
- Look for salary ranges like "$100K-$150K", "$100,000 - $150,000", "100k-150k USD"
- Look for hourly rates like "$50/hr", "$40-60 per hour"
- If only one number is given, use it as min with max as null
- Set isHourly: true for hourly rates, false for annual salaries
- If no salary is mentioned anywhere in the description, return null`;

    const userPrompt = `Analyze this job against the candidate's resume.

JOB POSTING:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location || 'Not specified'}
Remote: ${job.isRemote ? 'Yes' : 'No'}
${job.salaryMin ? `Salary: ${job.salaryCurrency || 'USD'} ${job.salaryMin}${job.salaryMax ? ` - ${job.salaryMax}` : ''}` : ''}

Description:
${job.description}

---

CANDIDATE RESUME:
${resumeText}

---

Provide your analysis in the required JSON format.`;

    try {
      const result = await callLLM<JobMatchOutput>(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        JobMatchSchema,
        JobMatchJsonSchema
      );

      return result;
    } catch (error) {
      logger.error('Matcher', 'Analysis failed', error);
      throw error;
    }
  }

  /**
   * Verify LLM output against source data
   */
  async verify(output: JobMatchResult, source: NormalizedJob): Promise<VerifiedOutput<JobMatchResult>> {
    const warnings: string[] = [];
    const descLower = source.description.toLowerCase();

    // Check if claimed matched skills appear in description
    for (const skill of output.matchedSkills) {
      if (!descLower.includes(skill.toLowerCase())) {
        warnings.push(`Skill "${skill}" not found in job description`);
      }
    }

    // Check if score is reasonable
    if (output.score > 95 && output.missingSkills.length > 2) {
      warnings.push('High score but many missing skills - may be hallucination');
    }

    if (warnings.length > 0) {
      logger.debug('Matcher', `Verification warnings: ${warnings.length}`, warnings);
    }

    return {
      data: output,
      verified: warnings.length === 0,
      warnings,
    };
  }
}
