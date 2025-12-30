import { getBot } from '../bot.js';
import type { NormalizedJob, JobMatchResult } from '../../core/types.js';
import type { MatchStats, MatchItem } from '../../scheduler/jobs/search-subscriptions.js';
import { logger } from '../../utils/logger.js';
import { saveMatchesToCSV, generateDownloadToken } from '../../utils/csv.js';
import { config } from '../../config.js';

// Subscription context for notifications
export interface SubscriptionContext {
  jobTitles: string[];
  location?: string | null;
  isRemote?: boolean;
}

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

function formatSubscriptionLabel(ctx: SubscriptionContext): string {
  const titles = ctx.jobTitles.slice(0, 2).join(', ');
  const moreTitles = ctx.jobTitles.length > 2 ? ` +${ctx.jobTitles.length - 2}` : '';

  let location = '';
  if (ctx.isRemote) {
    location = ctx.location ? `${ctx.location} (Remote)` : 'Remote';
  } else if (ctx.location) {
    location = ctx.location;
  }

  return location ? `${titles}${moreTitles} · ${location}` : `${titles}${moreTitles}`;
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
  matches: MatchItem[],
  stats: MatchStats = { skippedAlreadySent: 0, skippedBelowScore: 0, skippedCrossSubDuplicates: 0, previouslyMatchedOther: 0 },
  subscriptionContext?: SubscriptionContext
): Promise<void> {
  if (matches.length === 0) return;

  const bot = getBot();
  const sorted = [...matches].sort((a, b) => b.match.score - a.match.score);

  // Build header with subscription context if available
  let message = `<b>Found ${matches.length} New Job Match${matches.length > 1 ? 'es' : ''}!</b>\n`;
  if (subscriptionContext) {
    message += `<i>${escapeHtml(formatSubscriptionLabel(subscriptionContext))}</i>\n`;
  }

  // Show skipped stats (compact)
  const skipped: string[] = [];
  if (stats.skippedAlreadySent > 0) skipped.push(`${stats.skippedAlreadySent} already sent`);
  if (stats.skippedBelowScore > 0) skipped.push(`${stats.skippedBelowScore} below threshold`);
  if (stats.skippedCrossSubDuplicates > 0) skipped.push(`${stats.skippedCrossSubDuplicates} matched via other sub`);
  if (skipped.length > 0) message += `<i>(Skipped: ${skipped.join(', ')})</i>\n`;
  if (stats.previouslyMatchedOther > 0) message += `<i>(${stats.previouslyMatchedOther} also matched via other sub)</i>\n`;

  message += '\n';

  for (let i = 0; i < Math.min(sorted.length, 10); i++) {
    const { job, match, isPreviouslyMatched } = sorted[i];
    const salary = formatSalary(job, match);
    const location = job.isRemote ? 'Remote' : job.location || 'N/A';
    const marker = isPreviouslyMatched ? ' 🔄' : '';

    message += `<b>${i + 1}. ${escapeHtml(truncate(job.title, 40))}${marker}</b>\n`;
    message += `   ${escapeHtml(truncate(job.company, 30))} | ${match.score} pts\n`;
    message += `   ${escapeHtml(location)} | ${salary}\n`;

    if (job.applicationUrl) {
      message += `   <a href="${job.applicationUrl}">Apply</a>\n`;
    }
    message += '\n';
  }

  if (sorted.length > 10) {
    message += `<i>...and ${sorted.length - 10} more matches</i>\n`;
  }

  // Legend for 🔄 marker
  if (sorted.some(m => m.isPreviouslyMatched)) {
    message += `\n<i>🔄 = Also matched via another subscription</i>\n`;
  }

  // Generate CSV download link if 10+ matches and APP_URL is configured
  if (sorted.length >= 10 && config.APP_URL) {
    try {
      const csvFilename = await saveMatchesToCSV(sorted);
      const downloadToken = await generateDownloadToken(csvFilename);
      const downloadUrl = `${config.APP_URL}/download/${downloadToken}`;
      message += `\n📥 <a href="${downloadUrl}">Download all ${sorted.length} matches as CSV</a>`;
      logger.info('Telegram', `Generated CSV download: ${csvFilename}`);
    } catch (error) {
      logger.error('Telegram', 'Failed to generate CSV', error);
    }
  }

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
