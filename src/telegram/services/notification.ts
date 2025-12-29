import { getBot } from '../bot.js';
import type { NormalizedJob, JobMatchResult } from '../../core/types.js';
import { logger } from '../../utils/logger.js';

const MAX_MESSAGE_LENGTH = 3500; // Telegram limit is 4096, leave buffer

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

function formatScore(score: number): string {
  if (score >= 90) return `${score} (Excellent)`;
  if (score >= 70) return `${score} (Strong)`;
  if (score >= 50) return `${score} (Moderate)`;
  return `${score} (Weak)`;
}

function formatSalary(job: NormalizedJob, match: JobMatchResult): string {
  // Priority: job source data > AI-extracted > none
  if (job.salaryMin) {
    const currency = job.salaryCurrency || 'USD';
    const min = job.salaryMin.toLocaleString();
    const max = job.salaryMax ? job.salaryMax.toLocaleString() : '';
    return max ? `${currency} ${min} - ${max}` : `${currency} ${min}+`;
  }

  if (match.extractedSalary) {
    const s = match.extractedSalary;
    const type = s.isHourly ? '/hr' : '/yr';
    if (s.min && s.max) {
      return `${s.currency || 'USD'} ${s.min.toLocaleString()} - ${s.max.toLocaleString()}${type}`;
    }
    if (s.min) {
      return `${s.currency || 'USD'} ${s.min.toLocaleString()}+${type}`;
    }
  }

  return 'Not specified';
}

export async function sendJobNotification(
  chatId: bigint,
  job: NormalizedJob,
  match: JobMatchResult
): Promise<void> {
  const bot = getBot();

  // Format skills (truncate if too many)
  const matchedSkills =
    match.matchedSkills?.slice(0, 5).join(', ') || 'None detected';
  const missingSkills =
    match.missingSkills?.slice(0, 3).join(', ') || 'None';

  // Build location string
  const locationParts: string[] = [];
  if (job.location) locationParts.push(job.location);
  if (job.isRemote) locationParts.push('(Remote)');
  const locationText = locationParts.join(' ') || 'Location not specified';

  // Build message
  let message = `
<b>New Job Match!</b>

<b>${escapeHtml(job.title)}</b>
${escapeHtml(job.company)}
${escapeHtml(locationText)}

<b>Match Score:</b> ${formatScore(match.score)}
<b>Salary:</b> ${formatSalary(job, match)}

<b>Why it matches:</b>
${escapeHtml(truncate(match.reasoning || 'No reasoning provided', 300))}

<b>Matched Skills:</b> ${escapeHtml(matchedSkills)}
<b>Missing Skills:</b> ${escapeHtml(missingSkills)}
  `.trim();

  // Add apply link if available
  if (job.applicationUrl) {
    message += `\n\n<a href="${job.applicationUrl}">Apply Now</a>`;
  }

  // Truncate if too long
  if (message.length > MAX_MESSAGE_LENGTH) {
    message = message.substring(0, MAX_MESSAGE_LENGTH - 20) + '\n...[Truncated]';
  }

  try {
    await bot.api.sendMessage(Number(chatId), message, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }, // Don't expand link previews
    });
  } catch (error) {
    logger.error('Telegram', `Failed to send notification to ${chatId}`, error);
    throw error;
  }
}

// Send a batch summary of new matches
export async function sendMatchSummary(
  chatId: bigint,
  matches: Array<{ job: NormalizedJob; match: JobMatchResult }>
): Promise<void> {
  if (matches.length === 0) return;

  const bot = getBot();

  // Sort by score descending
  const sorted = [...matches].sort((a, b) => b.match.score - a.match.score);

  let message = `<b>Found ${matches.length} New Job Match${matches.length > 1 ? 'es' : ''}!</b>\n\n`;

  for (let i = 0; i < Math.min(sorted.length, 10); i++) {
    const { job, match } = sorted[i];
    const salary = formatSalary(job, match);
    const location = job.isRemote ? 'Remote' : job.location || 'N/A';

    message += `<b>${i + 1}. ${escapeHtml(truncate(job.title, 40))}</b>\n`;
    message += `   ${escapeHtml(truncate(job.company, 30))} | ${match.score} pts\n`;
    message += `   ${escapeHtml(location)} | ${salary}\n`;

    if (job.applicationUrl) {
      message += `   <a href="${job.applicationUrl}">Apply</a>\n`;
    }
    message += '\n';
  }

  if (sorted.length > 10) {
    message += `<i>...and ${sorted.length - 10} more matches</i>`;
  }

  // Truncate if too long
  if (message.length > MAX_MESSAGE_LENGTH) {
    message = message.substring(0, MAX_MESSAGE_LENGTH - 20) + '\n...[Truncated]';
  }

  try {
    await bot.api.sendMessage(Number(chatId), message, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    logger.error('Telegram', `Failed to send summary to ${chatId}`, error);
    throw error;
  }
}

// Helper to send a simple text message
export async function sendMessage(
  chatId: bigint,
  text: string,
  parseMode: 'HTML' | 'MarkdownV2' | undefined = 'HTML'
): Promise<void> {
  const bot = getBot();

  try {
    await bot.api.sendMessage(Number(chatId), text, {
      parse_mode: parseMode,
    });
  } catch (error) {
    logger.error('Telegram', `Failed to send message to ${chatId}`, error);
    throw error;
  }
}
