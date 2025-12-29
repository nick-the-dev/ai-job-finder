import crypto from 'crypto';
import { NormalizedJob, JobMatchResult, ExtractedSalary } from '../core/types.js';
import { writeFile, mkdir, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { getDb } from '../db/client.js';

const EXPORTS_DIR = join(process.cwd(), 'exports');

/**
 * Generate a secure download token for a CSV file
 * Stores token in database for persistence across restarts
 */
export async function generateDownloadToken(filename: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await getDb().downloadToken.create({
    data: { token, filename },
  });
  return token;
}

/**
 * Validate and get filename for download token
 * Returns null if token is invalid (tokens no longer expire)
 */
export async function validateDownloadToken(token: string): Promise<string | null> {
  const entry = await getDb().downloadToken.findUnique({
    where: { token },
  });
  if (!entry) return null;
  return entry.filename;
}

/**
 * Get file content for download
 */
export async function getExportFile(filename: string): Promise<Buffer | null> {
  const filepath = join(EXPORTS_DIR, filename);

  // Security: ensure path doesn't escape exports directory
  if (!filepath.startsWith(EXPORTS_DIR) || filename.includes('..')) {
    return null;
  }

  if (!existsSync(filepath)) {
    return null;
  }

  return readFile(filepath);
}


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
 * Extract salary information from job description text
 * Returns { min, max, currency, isHourly } or null if not found
 */
function extractSalaryFromDescription(description: string): { min?: number; max?: number; currency?: string; isHourly?: boolean } | null {
  if (!description) return null;

  // Normalize escaped characters (e.g., \- becomes -)
  const normalizedDesc = description.replace(/\\-/g, '-').replace(/\\–/g, '–');

  // Hourly rate patterns (check first to identify hourly vs annual)
  const hourlyPatterns = [
    // $25/hr, $30-$40/hour, $25 - $35 per hour
    /\$\s*([\d,.]+)\s*[-–—to]*\s*\$?\s*([\d,.]+)?\s*(?:\/|\s+per\s+)?\s*(?:hr|hour|hourly)/gi,
    // $25/h
    /\$\s*([\d,.]+)\s*\/\s*h\b/gi,
  ];

  for (const pattern of hourlyPatterns) {
    const match = pattern.exec(normalizedDesc);
    if (match) {
      const min = parseFloat(match[1].replace(/,/g, ''));
      const max = match[2] ? parseFloat(match[2].replace(/,/g, '')) : undefined;
      return { min, max, currency: 'USD', isHourly: true };
    }
  }

  // Annual salary patterns
  const patterns = [
    // $100,000 - $150,000 or $100K - $150K (with optional year suffix)
    /\$\s*([\d,]+\.?\d*)\s*[kK]?\s*[-–—to]+\s*\$?\s*([\d,]+\.?\d*)\s*[kK]?(?:\s*(?:per\s+)?(?:year|yr|annually|annual|pa|p\.a\.))?/gi,
    // $45,700 - $74,400 CAD (currency after range)
    /\$\s*([\d,]+\.?\d*)\s*[-–—to]+\s*\$?\s*([\d,]+\.?\d*)\s*(?:CAD|USD|EUR|GBP|AUD)/gi,
    // $100,000/year or $100K/yr
    /\$\s*([\d,]+\.?\d*)\s*[kK]?\s*(?:\/|\s+per\s+)?\s*(?:year|yr|annually|annual|pa|p\.a\.)/gi,
    // 100,000 - 150,000 USD/EUR
    /([\d,]+\.?\d*)\s*[kK]?\s*[-–—to]+\s*([\d,]+\.?\d*)\s*[kK]?\s*(?:USD|EUR|GBP|CAD|AUD)/gi,
    // Salary: $100,000
    /salary[:\s]+\$?\s*([\d,]+\.?\d*)\s*[kK]?/gi,
    // $100K+ or $100,000+
    /\$\s*([\d,]+\.?\d*)\s*[kK]?\s*\+/gi,
    // €50,000 - €70,000 or €50K - €70K
    /€\s*([\d,]+\.?\d*)\s*[kK]?\s*[-–—to]+\s*€?\s*([\d,]+\.?\d*)\s*[kK]?/gi,
    // £50,000 - £70,000
    /£\s*([\d,]+\.?\d*)\s*[kK]?\s*[-–—to]+\s*£?\s*([\d,]+\.?\d*)\s*[kK]?/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(normalizedDesc);
    if (match) {
      let min = parseFloat(match[1].replace(/,/g, ''));
      let max = match[2] ? parseFloat(match[2].replace(/,/g, '')) : undefined;

      // Handle K notation (e.g., 100K = 100,000)
      const hasK = /[kK]/.test(match[0]);
      if (hasK && min < 1000) {
        min = min * 1000;
        if (max && max < 1000) max = max * 1000;
      }

      // Determine currency
      let currency = 'USD';
      if (match[0].includes('€')) currency = 'EUR';
      else if (match[0].includes('£')) currency = 'GBP';
      else if (/CAD/i.test(match[0])) currency = 'CAD';
      else if (/AUD/i.test(match[0])) currency = 'AUD';
      else if (/EUR/i.test(match[0])) currency = 'EUR';
      else if (/GBP/i.test(match[0])) currency = 'GBP';

      return { min, max, currency };
    }
  }

  return null;
}

/**
 * Format salary as a single string
 * Priority: 1) Job source data (from scraper), 2) AI-extracted from description, 3) Regex fallback
 */
function formatSalary(job: NormalizedJob, aiExtracted?: ExtractedSalary | null): string {
  let min: number | null | undefined = job.salaryMin;
  let max: number | null | undefined = job.salaryMax;
  let currency = job.salaryCurrency || 'USD';
  let isHourly = false;

  // If no salary data from source, use AI-extracted salary
  if (!min && !max && aiExtracted) {
    min = aiExtracted.min;
    max = aiExtracted.max;
    currency = aiExtracted.currency || currency;
    isHourly = aiExtracted.isHourly || false;
  }

  // Regex fallback if AI didn't extract salary
  if (!min && !max && job.description) {
    const regexExtracted = extractSalaryFromDescription(job.description);
    if (regexExtracted) {
      min = regexExtracted.min;
      max = regexExtracted.max;
      currency = regexExtracted.currency || currency;
      isHourly = regexExtracted.isHourly || false;
    }
  }

  if (!min && !max) return '';

  // Format number with commas
  const fmt = (n: number) => n.toLocaleString('en-US');

  // Currency symbol
  const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$', AUD: 'A$' };
  const symbol = symbols[currency] || currency + ' ';
  const suffix = isHourly ? '/hr' : '';

  if (min && max) {
    return `${symbol}${fmt(min)} - ${symbol}${fmt(max)}${suffix}`;
  } else if (min) {
    return `${symbol}${fmt(min)}${isHourly ? '/hr' : '+'}`;
  } else if (max) {
    return `Up to ${symbol}${fmt(max)}${suffix}`;
  }

  return '';
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
    'Salary',
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
    escapeCSV(formatSalary(job, match.extractedSalary)),
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
