/**
 * Core types - shared across the application
 */

export interface RawJob {
  title: string;
  company: string;
  description: string;
  location?: string;
  isRemote?: boolean;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  applicationUrl?: string;
  postedDate?: Date;
  source: 'serpapi' | 'jobspy';
  sourceId?: string;
}

export interface NormalizedJob extends RawJob {
  contentHash: string;
}

export interface ExtractedSalary {
  min: number | null;
  max: number | null;
  currency: string;
  isHourly: boolean;
}

export interface JobMatchResult {
  score: number;          // 1-100
  reasoning: string;      // Why this score
  matchedSkills: string[];
  missingSkills: string[];
  pros: string[];
  cons: string[];
  extractedSalary?: ExtractedSalary | null;  // AI-extracted salary info
}

export interface SearchRequest {
  jobTitles: string[];
  location?: string;
  isRemote?: boolean;
  resumeText?: string;
  excludedTitles?: string[];
  excludedCompanies?: string[];
}

export interface SearchResult {
  jobsCollected: number;
  jobsAfterDedup: number;
  jobsMatched: number;
  matches: Array<{
    job: NormalizedJob;
    match: JobMatchResult;
  }>;
}
