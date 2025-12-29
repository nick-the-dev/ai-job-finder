import { NormalizedJob, JobMatchResult } from '../core/types.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const EXPORTS_DIR = join(process.cwd(), 'exports');

interface MatchEntry {
  job: NormalizedJob;
  match: JobMatchResult;
}

/**
 * Safely format a date string, returning empty string if invalid
 */
function formatDate(dateValue: string | Date): string {
  try {
    const date = new Date(dateValue);
    if (isNaN(date.getTime())) return '';
    return date.toISOString().split('T')[0];
  } catch {
    return '';
  }
}

/**
 * Escape a value for CSV (handle commas, quotes, newlines)
 */
function escapeCSV(value: string | number | boolean | undefined | null): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Convert matches array to CSV string
 */
function matchesToCSV(matches: MatchEntry[]): string {
  const headers = [
    'Score',
    'Title',
    'Company',
    'Location',
    'Remote',
    'Salary Min',
    'Salary Max',
    'Currency',
    'Application URL',
    'Posted Date',
    'Source',
    'Matched Skills',
    'Missing Skills',
    'Pros',
    'Cons',
    'Reasoning',
  ];

  const rows = matches.map(({ job, match }) => [
    match.score,
    escapeCSV(job.title),
    escapeCSV(job.company),
    escapeCSV(job.location),
    job.isRemote ? 'Yes' : 'No',
    job.salaryMin ?? '',
    job.salaryMax ?? '',
    escapeCSV(job.salaryCurrency),
    escapeCSV(job.applicationUrl),
    job.postedDate ? formatDate(job.postedDate) : '',
    escapeCSV(job.source),
    escapeCSV(match.matchedSkills.join('; ')),
    escapeCSV(match.missingSkills.join('; ')),
    escapeCSV(match.pros.join('; ')),
    escapeCSV(match.cons.join('; ')),
    escapeCSV(match.reasoning),
  ]);

  return [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
}

/**
 * Save matches to CSV file and return the filename
 */
export async function saveMatchesToCSV(matches: MatchEntry[]): Promise<string> {
  await mkdir(EXPORTS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `job-matches-${timestamp}.csv`;
  const filepath = join(EXPORTS_DIR, filename);

  const csv = matchesToCSV(matches);
  await writeFile(filepath, csv, 'utf-8');

  return filename;
}
