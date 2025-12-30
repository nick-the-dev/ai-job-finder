import crypto from 'crypto';
import { InlineKeyboard } from 'grammy';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { getDb } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { runSingleSubscriptionSearch } from '../../scheduler/jobs/search-subscriptions.js';
import { LocationNormalizerAgent } from '../../agents/location-normalizer.js';
import type { NormalizedLocation } from '../../schemas/llm-outputs.js';

interface ConversationData {
  jobTitles?: string[];
  location?: string;              // DEPRECATED: kept for backwards compatibility
  isRemote?: boolean;             // DEPRECATED: kept for backwards compatibility
  normalizedLocations?: NormalizedLocation[];  // New structured locations
  pendingLocationText?: string;   // User's location input awaiting confirmation
  resumeText?: string;
  resumeName?: string;
  minScore?: number;
  datePosted?: string;
  excludedTitles?: string[];
  excludedCompanies?: string[];
  skipCrossSubDuplicates?: boolean;
}

// Date range options for JobSpy
const DATE_RANGE_OPTIONS: Record<string, string> = {
  '1': 'today',
  '2': '3days',
  '3': 'week',
  '4': 'month',
  '5': 'all',
};

const DATE_RANGE_LABELS: Record<string, string> = {
  today: 'Last 24 hours',
  '3days': 'Last 3 days',
  week: 'Last week',
  month: 'Last month',
  all: 'All time',
};

function getResumeHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
}

/**
 * Show location confirmation message with parsed locations
 */
async function showLocationConfirmation(
  ctx: BotContext,
  db: ReturnType<typeof getDb>,
  data: ConversationData,
  locations: NormalizedLocation[]
): Promise<void> {
  if (!ctx.telegramUser) return;

  // Deduplicate locations (e.g., user says "Remote... USA remote" - keep only one Remote)
  const dedupedLocations = LocationNormalizerAgent.deduplicate(locations);

  // Format locations for display
  let locationDisplay: string;
  if (dedupedLocations.length === 0) {
    locationDisplay = 'Anywhere';
  } else {
    const lines = dedupedLocations.map(loc => {
      if (loc.type === 'remote') {
        return '• Remote';
      }
      return `• ${loc.display}`;
    });
    locationDisplay = lines.join('\n');
  }

  // Save deduplicated locations and move to confirmation state
  await db.telegramUser.update({
    where: { id: ctx.telegramUser.id },
    data: {
      conversationState: 'awaiting_location_confirmation',
      conversationData: { ...data, normalizedLocations: dedupedLocations },
    },
  });

  const keyboard = new InlineKeyboard()
    .text('✓ Looks good', 'loc_confirm')
    .text('✎ Change', 'loc_change');

  await ctx.reply(
    `<b>I'll search in:</b>\n${locationDisplay}\n`,
    { parse_mode: 'HTML', reply_markup: keyboard }
  );
}

export function setupConversation(bot: Bot<BotContext>): void {
  // Handle location confirmation callback
  bot.callbackQuery('loc_confirm', async (ctx) => {
    if (!ctx.telegramUser) return;

    const db = getDb();
    const data = (ctx.telegramUser.conversationData as ConversationData) || {};

    // Also set legacy fields for backwards compatibility
    const hasRemote = data.normalizedLocations?.some(l => l.type === 'remote') ?? false;
    const physicalLocations = data.normalizedLocations?.filter(l => l.type === 'physical') ?? [];
    const legacyLocation = physicalLocations.length > 0
      ? physicalLocations.map(l => l.display).join(', ')
      : undefined;

    await db.telegramUser.update({
      where: { id: ctx.telegramUser.id },
      data: {
        conversationState: 'awaiting_resume',
        conversationData: {
          ...data,
          // Legacy fields for backwards compatibility
          location: legacyLocation,
          isRemote: hasRemote,
        },
      },
    });

    const locationDisplay = LocationNormalizerAgent.formatForDisplay(data.normalizedLocations || []);

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `<b>📍 Location:</b>\n${locationDisplay}\n\n` +
        '<b>Step 3/7: Resume</b>\n\n' +
        'Now I need your resume to match you with jobs.\n\n' +
        'You can:\n' +
        '- <b>Upload</b> a PDF or DOCX file\n' +
        '- <b>Paste</b> your resume text directly here',
      { parse_mode: 'HTML' }
    );
  });

  // Handle location change callback
  bot.callbackQuery('loc_change', async (ctx) => {
    if (!ctx.telegramUser) return;

    const db = getDb();
    const data = (ctx.telegramUser.conversationData as ConversationData) || {};

    await db.telegramUser.update({
      where: { id: ctx.telegramUser.id },
      data: {
        conversationState: 'awaiting_location',
        conversationData: {
          ...data,
          normalizedLocations: undefined,
          pendingLocationText: undefined,
        },
      },
    });

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      'No problem! Enter your locations again:\n\n' +
        '<b>Examples:</b>\n' +
        '• <code>NYC, Boston</code> - multiple cities\n' +
        '• <code>Remote</code> - remote jobs only\n' +
        '• <code>SF or Remote</code> - either SF area or remote',
      { parse_mode: 'HTML' }
    );
  });

  // Handle location clarification callback
  bot.callbackQuery(/^loc_clarify:(\d+)$/, async (ctx) => {
    if (!ctx.telegramUser) return;

    const db = getDb();
    const data = ctx.telegramUser.conversationData as ConversationData & { _clarificationOptions?: string[] };
    const optionIndex = parseInt(ctx.match[1], 10);
    const options = data._clarificationOptions || [];
    const selectedOption = options[optionIndex];

    if (!selectedOption) {
      await ctx.answerCallbackQuery({ text: 'Invalid option' });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`<i>Selected: ${selectedOption}</i>`, { parse_mode: 'HTML' });

    // Re-parse with the clarification
    try {
      const normalizer = new LocationNormalizerAgent();
      const result = await normalizer.execute({
        text: data.pendingLocationText || '',
        clarification: selectedOption,
      });

      if (result.needsClarification) {
        // Still needs more clarification
        const keyboard = new InlineKeyboard();
        result.needsClarification.options.forEach((option, idx) => {
          keyboard.text(option, `loc_clarify:${idx}`).row();
        });

        await db.telegramUser.update({
          where: { id: ctx.telegramUser.id },
          data: {
            conversationData: {
              ...data,
              _clarificationOptions: result.needsClarification.options,
            },
          },
        });

        await ctx.reply(
          `<b>${result.needsClarification.question}</b>`,
          { parse_mode: 'HTML', reply_markup: keyboard }
        );
        return;
      }

      // Clean up temp data and show confirmation
      const cleanData = { ...data };
      delete (cleanData as Record<string, unknown>)._clarificationOptions;

      await showLocationConfirmation(ctx as BotContext, db, cleanData, result.locations);
    } catch (error) {
      logger.error('Telegram', 'Location clarification callback failed', error);
      await ctx.reply(
        'Sorry, I had trouble understanding. Let\'s try again.\n\n' +
          'Where should I search for jobs?'
      );

      await db.telegramUser.update({
        where: { id: ctx.telegramUser.id },
        data: {
          conversationState: 'awaiting_location',
          conversationData: { ...data, pendingLocationText: undefined, _clarificationOptions: undefined },
        },
      });
    }
  });

  // Handle text messages for conversation flow
  bot.on('message:text', async (ctx) => {
    if (!ctx.telegramUser) return;

    const state = ctx.telegramUser.conversationState;
    if (!state) return; // Not in a conversation

    const text = ctx.message.text.trim();
    const db = getDb();

    // Get current conversation data
    const data = (ctx.telegramUser.conversationData as ConversationData) || {};

    switch (state) {
      case 'awaiting_titles': {
        const titles = text
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0);

        if (titles.length === 0) {
          await ctx.reply('Please enter at least one job title.');
          return;
        }

        // Save and move to next step
        await db.telegramUser.update({
          where: { id: ctx.telegramUser.id },
          data: {
            conversationState: 'awaiting_location',
            conversationData: { ...data, jobTitles: titles },
          },
        });

        await ctx.reply(
          `<b>Got it!</b> Searching for: ${titles.join(', ')}\n\n` +
            '<b>Step 2/7: Location</b>\n\n' +
            'Where should I search for jobs?\n\n' +
            '<b>Examples:</b>\n' +
            '• <code>New York</code> - single city\n' +
            '• <code>NYC, Boston, Austin</code> - multiple cities\n' +
            '• <code>Remote</code> - remote jobs only\n' +
            '• <code>SF or Remote</code> - either SF area or remote\n' +
            '• <code>USA</code> - anywhere in USA\n' +
            '• <code>Anywhere</code> - no location filter\n\n' +
            'Just type naturally!',
          { parse_mode: 'HTML' }
        );
        break;
      }

      case 'awaiting_location': {
        const lowerText = text.toLowerCase();

        // Handle quick keywords without LLM
        if (lowerText === 'skip' || lowerText === 'any' || lowerText === 'anywhere' || lowerText === 'worldwide') {
          await db.telegramUser.update({
            where: { id: ctx.telegramUser.id },
            data: {
              conversationState: 'awaiting_resume',
              conversationData: { ...data, normalizedLocations: [], location: undefined, isRemote: false },
            },
          });

          await ctx.reply(
            `<b>📍 Location:</b> Anywhere\n\n` +
              '<b>Step 3/7: Resume</b>\n\n' +
              'Now I need your resume to match you with jobs.\n\n' +
              'You can:\n' +
              '- <b>Upload</b> a PDF or DOCX file\n' +
              '- <b>Paste</b> your resume text directly here',
            { parse_mode: 'HTML' }
          );
          break;
        }

        // Use LLM to parse location
        await ctx.reply('🔍 <i>Parsing your location...</i>', { parse_mode: 'HTML' });

        try {
          const normalizer = new LocationNormalizerAgent();
          const result = await normalizer.execute({ text });

          if (result.needsClarification) {
            // Need to ask user for clarification
            const keyboard = new InlineKeyboard();
            result.needsClarification.options.forEach((option, idx) => {
              keyboard.text(option, `loc_clarify:${idx}`).row();
            });

            await db.telegramUser.update({
              where: { id: ctx.telegramUser.id },
              data: {
                conversationState: 'awaiting_location_clarification',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                conversationData: JSON.parse(JSON.stringify({
                  ...data,
                  pendingLocationText: text,
                  _clarificationOptions: result.needsClarification.options,
                })) as any,
              },
            });

            await ctx.reply(
              `<b>${result.needsClarification.question}</b>`,
              { parse_mode: 'HTML', reply_markup: keyboard }
            );
            break;
          }

          // Parsed successfully, show confirmation
          await showLocationConfirmation(ctx, db, data, result.locations);
        } catch (error) {
          logger.error('Telegram', 'Location parsing failed', error);
          await ctx.reply(
            'Sorry, I had trouble parsing that location. Please try again with a simpler format.\n\n' +
              'Examples: <code>NYC</code>, <code>Remote</code>, <code>USA</code>',
            { parse_mode: 'HTML' }
          );
        }
        break;
      }

      case 'awaiting_location_clarification': {
        // User typed a text response instead of using buttons
        // Treat as clarification and re-parse
        const pendingText = data.pendingLocationText || '';

        try {
          const normalizer = new LocationNormalizerAgent();
          const result = await normalizer.execute({
            text: pendingText,
            clarification: text,
          });

          if (result.needsClarification) {
            // Still needs clarification - show options again
            const keyboard = new InlineKeyboard();
            result.needsClarification.options.forEach((option, idx) => {
              keyboard.text(option, `loc_clarify:${idx}`).row();
            });

            await ctx.reply(
              `<b>${result.needsClarification.question}</b>`,
              { parse_mode: 'HTML', reply_markup: keyboard }
            );
            break;
          }

          await showLocationConfirmation(ctx, db, data, result.locations);
        } catch (error) {
          logger.error('Telegram', 'Location clarification failed', error);
          // Reset to location step
          await db.telegramUser.update({
            where: { id: ctx.telegramUser.id },
            data: {
              conversationState: 'awaiting_location',
              conversationData: { ...data, pendingLocationText: undefined },
            },
          });

          await ctx.reply(
            'Sorry, I had trouble understanding. Let\'s try again.\n\n' +
              'Where should I search for jobs?',
            { parse_mode: 'HTML' }
          );
        }
        break;
      }

      case 'awaiting_location_confirmation': {
        // User typed something instead of using buttons - treat as new location input
        // Reset to location parsing with the new text
        await db.telegramUser.update({
          where: { id: ctx.telegramUser.id },
          data: {
            conversationState: 'awaiting_location',
            conversationData: { ...data, normalizedLocations: undefined, pendingLocationText: undefined },
          },
        });

        // Re-trigger the awaiting_location handler by calling it directly
        // This is a bit of a hack, but avoids code duplication
        const lowerText = text.toLowerCase();

        if (lowerText === 'skip' || lowerText === 'any' || lowerText === 'anywhere' || lowerText === 'worldwide') {
          await db.telegramUser.update({
            where: { id: ctx.telegramUser.id },
            data: {
              conversationState: 'awaiting_resume',
              conversationData: { ...data, normalizedLocations: [], location: undefined, isRemote: false },
            },
          });

          await ctx.reply(
            `<b>📍 Location:</b> Anywhere\n\n` +
              '<b>Step 3/7: Resume</b>\n\n' +
              'Now I need your resume to match you with jobs.\n\n' +
              'You can:\n' +
              '- <b>Upload</b> a PDF or DOCX file\n' +
              '- <b>Paste</b> your resume text directly here',
            { parse_mode: 'HTML' }
          );
          break;
        }

        await ctx.reply('🔍 <i>Parsing your location...</i>', { parse_mode: 'HTML' });

        try {
          const normalizer = new LocationNormalizerAgent();
          const result = await normalizer.execute({ text });

          if (result.needsClarification) {
            const keyboard = new InlineKeyboard();
            result.needsClarification.options.forEach((option, idx) => {
              keyboard.text(option, `loc_clarify:${idx}`).row();
            });

            await db.telegramUser.update({
              where: { id: ctx.telegramUser.id },
              data: {
                conversationState: 'awaiting_location_clarification',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                conversationData: JSON.parse(JSON.stringify({
                  ...data,
                  pendingLocationText: text,
                  _clarificationOptions: result.needsClarification.options,
                })) as any,
              },
            });

            await ctx.reply(
              `<b>${result.needsClarification.question}</b>`,
              { parse_mode: 'HTML', reply_markup: keyboard }
            );
            break;
          }

          await showLocationConfirmation(ctx, db, data, result.locations);
        } catch (error) {
          logger.error('Telegram', 'Location parsing failed', error);
          await ctx.reply(
            'Sorry, I had trouble parsing that location. Please try again.',
            { parse_mode: 'HTML' }
          );
        }
        break;
      }

      case 'awaiting_resume': {
        // Text resume (file uploads handled separately in document.ts)
        if (text.length < 100) {
          await ctx.reply(
            'Your resume seems too short. Please paste your full resume or upload a PDF/DOCX file.'
          );
          return;
        }

        await db.telegramUser.update({
          where: { id: ctx.telegramUser.id },
          data: {
            conversationState: 'awaiting_min_score',
            conversationData: { ...data, resumeText: text, resumeName: 'Pasted text' },
          },
        });

        await ctx.reply(
          `<b>Resume received!</b> (${text.length} characters)\n\n` +
            '<b>Step 4/7: Minimum Match Score</b>\n\n' +
            "I'll only notify you about jobs with a score >= this value.\n\n" +
            '<b>Score ranges:</b>\n' +
            '- 90-100: Perfect match\n' +
            '- 70-89: Strong match\n' +
            '- 50-69: Moderate match\n' +
            '- 30-49: Weak match\n\n' +
            'Send a number (1-100) or <b>"Skip"</b> for default (60)',
          { parse_mode: 'HTML' }
        );
        break;
      }

      case 'awaiting_min_score': {
        let minScore = 60;

        const lowerText = text.toLowerCase();
        if (lowerText !== 'skip') {
          const parsed = parseInt(text, 10);
          if (isNaN(parsed) || parsed < 1 || parsed > 100) {
            await ctx.reply(
              'Please enter a number between 1 and 100, or "Skip" for default (60).'
            );
            return;
          }
          minScore = parsed;
        }

        // Move to date range step
        await db.telegramUser.update({
          where: { id: ctx.telegramUser.id },
          data: {
            conversationState: 'awaiting_date_range',
            conversationData: { ...data, minScore },
          },
        });

        await ctx.reply(
          `<b>Min Score:</b> ${minScore}\n\n` +
            '<b>Step 5/7: Job Posting Date Range</b>\n\n' +
            'How far back should I search for jobs?\n\n' +
            '1️⃣ Last 24 hours\n' +
            '2️⃣ Last 3 days\n' +
            '3️⃣ Last week\n' +
            '4️⃣ Last month (Recommended)\n' +
            '5️⃣ All time\n\n' +
            'Send a number (1-5) or <b>"Skip"</b> for default (Last month)',
          { parse_mode: 'HTML' }
        );
        break;
      }

      case 'awaiting_date_range': {
        let datePosted = 'month'; // default

        const lowerText = text.toLowerCase();
        if (lowerText !== 'skip') {
          const choice = DATE_RANGE_OPTIONS[text];
          if (!choice) {
            await ctx.reply(
              'Please enter a number 1-5, or "Skip" for default (Last month).'
            );
            return;
          }
          datePosted = choice;
        }

        // Move to excluded titles step
        await db.telegramUser.update({
          where: { id: ctx.telegramUser.id },
          data: {
            conversationState: 'awaiting_excluded_titles',
            conversationData: { ...data, datePosted },
          },
        });

        await ctx.reply(
          `<b>Date Range:</b> ${DATE_RANGE_LABELS[datePosted]}\n\n` +
            '<b>Step 6/7: Excluded Job Titles (Optional)</b>\n\n' +
            'Any job title keywords to exclude?\n\n' +
            'Examples: <b>"Manager, Director, Lead"</b>\n' +
            '(Jobs with these words in the title will be skipped)\n\n' +
            'Send keywords separated by commas, or <b>"Skip"</b> to continue',
          { parse_mode: 'HTML' }
        );
        break;
      }

      case 'awaiting_excluded_titles': {
        let excludedTitles: string[] = [];

        const lowerText = text.toLowerCase();
        if (lowerText !== 'skip') {
          excludedTitles = text
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
        }

        await db.telegramUser.update({
          where: { id: ctx.telegramUser.id },
          data: {
            conversationState: 'awaiting_excluded_companies',
            conversationData: { ...data, excludedTitles },
          },
        });

        const excludedText = excludedTitles.length > 0
          ? excludedTitles.join(', ')
          : 'None';

        await ctx.reply(
          `<b>Excluded Titles:</b> ${excludedText}\n\n` +
            '<b>Step 7/7: Excluded Companies (Optional)</b>\n\n' +
            'Any companies to exclude?\n\n' +
            'Examples: <b>"Amazon, Meta, Google"</b>\n' +
            '(Jobs from these companies will be skipped)\n\n' +
            'Send company names separated by commas, or <b>"Skip"</b> to finish',
          { parse_mode: 'HTML' }
        );
        break;
      }

      case 'awaiting_excluded_companies': {
        let excludedCompanies: string[] = [];

        const lowerText = text.toLowerCase();
        if (lowerText !== 'skip') {
          excludedCompanies = text
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
        }

        // Move to step 8: cross-subscription duplicates preference
        await db.telegramUser.update({
          where: { id: ctx.telegramUser.id },
          data: {
            conversationState: 'awaiting_cross_sub_preference',
            conversationData: { ...data, excludedCompanies },
          },
        });

        const excludedText = excludedCompanies.length > 0
          ? excludedCompanies.join(', ')
          : 'None';

        await ctx.reply(
          `<b>Excluded Companies:</b> ${excludedText}\n\n` +
            '<b>Step 8/8: Cross-Subscription Duplicates</b>\n\n' +
            'If a job matches multiple of your subscriptions, should I:\n\n' +
            '1️⃣ <b>Skip it</b> - Only notify once (Recommended)\n' +
            '2️⃣ <b>Show it</b> - Notify for each subscription (marked with 🔄)\n\n' +
            'Send <b>1</b> or <b>2</b>, or <b>"Skip"</b> for default (Skip duplicates)',
          { parse_mode: 'HTML' }
        );
        break;
      }

      case 'awaiting_cross_sub_preference': {
        let skipCrossSubDuplicates = true; // default

        const lowerText = text.toLowerCase();
        if (lowerText !== 'skip') {
          if (text === '1') {
            skipCrossSubDuplicates = true;
          } else if (text === '2') {
            skipCrossSubDuplicates = false;
          } else {
            await ctx.reply('Please enter 1 or 2, or "Skip" for default.');
            return;
          }
        }

        // Create subscription with all data
        const finalData = { ...data, skipCrossSubDuplicates } as ConversationData;
        await createSubscription(ctx, finalData);
        break;
      }

      default:
        // Unknown state, clear it
        await db.telegramUser.update({
          where: { id: ctx.telegramUser.id },
          data: {
            conversationState: undefined,
            conversationData: undefined,
          },
        });
    }
  });
}

async function createSubscription(
  ctx: BotContext,
  data: ConversationData
): Promise<void> {
  if (!ctx.telegramUser) return;

  const db = getDb();

  try {
    // Validate all required fields
    if (!data.jobTitles?.length || !data.resumeText) {
      await ctx.reply(
        'Missing required information. Please start over with /subscribe.'
      );
      return;
    }

    const resumeHash = getResumeHash(data.resumeText);

    // Count existing active subscriptions
    const activeCount = await db.searchSubscription.count({
      where: { userId: ctx.telegramUser.id, isActive: true },
    });

    if (activeCount >= 5) {
      await ctx.reply(
        'You have reached the maximum of 5 active subscriptions.\n\n' +
          'Use /mysubs to manage existing subscriptions before creating a new one.'
      );
      return;
    }

    // Update user's cross-sub preference if changed
    if (data.skipCrossSubDuplicates !== undefined) {
      await db.telegramUser.update({
        where: { id: ctx.telegramUser.id },
        data: { skipCrossSubDuplicates: data.skipCrossSubDuplicates },
      });
    }

    // Create new subscription (multiple allowed)
    // Note: normalizedLocations added via schema but Prisma client types may need regeneration
    const subscriptionData = {
      userId: ctx.telegramUser.id,
      jobTitles: data.jobTitles,
      location: data.location,
      isRemote: data.isRemote ?? true,
      normalizedLocations: data.normalizedLocations ?? null,  // New structured locations
      minScore: data.minScore ?? 60,
      datePosted: data.datePosted ?? 'month',
      resumeText: data.resumeText,
      resumeHash,
      resumeName: data.resumeName,
      resumeUploadedAt: new Date(),
      excludedTitles: data.excludedTitles ?? [],
      excludedCompanies: data.excludedCompanies ?? [],
      isActive: true,
      isPaused: false,
    };
    const subscription = await db.searchSubscription.create({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: subscriptionData as any,
    });

    // Clear conversation state
    await db.telegramUser.update({
      where: { id: ctx.telegramUser.id },
      data: {
        conversationState: undefined,
        conversationData: undefined,
      },
    });

    // Format location for display
    const locationText = data.normalizedLocations?.length
      ? LocationNormalizerAgent.formatForDisplaySingleLine(data.normalizedLocations)
      : data.isRemote
        ? 'Remote only'
        : data.location
          ? data.location
          : 'Any location';

    const dateRangeText = DATE_RANGE_LABELS[data.datePosted ?? 'month'] || 'Last month';
    const excludedTitlesText = data.excludedTitles?.length
      ? data.excludedTitles.join(', ')
      : 'None';
    const excludedCompaniesText = data.excludedCompanies?.length
      ? data.excludedCompanies.join(', ')
      : 'None';
    const crossSubText = data.skipCrossSubDuplicates === false
      ? 'Show with 🔄 marker'
      : 'Skip duplicates';

    // Build inline keyboard
    const keyboard = new InlineKeyboard()
      .text('📋 My Subscriptions', 'sub:list')
      .text('➕ Add Another', 'sub:new');

    await ctx.reply(
      '<b>✅ Subscription created!</b>\n\n' +
        `<b>Job Titles:</b> ${data.jobTitles.join(', ')}\n` +
        `<b>Location:</b> ${locationText}\n` +
        `<b>Min Score:</b> ${data.minScore ?? 60}\n` +
        `<b>Date Range:</b> ${dateRangeText}\n` +
        `<b>Resume:</b> ${data.resumeName || 'Uploaded'}\n` +
        `<b>Excluded Titles:</b> ${excludedTitlesText}\n` +
        `<b>Excluded Companies:</b> ${excludedCompaniesText}\n` +
        `<b>Cross-Sub Duplicates:</b> ${crossSubText}\n\n` +
        '🔍 <b>Starting your first scan now...</b>\n' +
        "I'll notify you when I find matches, and continue searching every hour.",
      { parse_mode: 'HTML', reply_markup: keyboard }
    );

    logger.info(
      'Telegram',
      `User ${ctx.telegramUser.telegramId} created subscription: ${data.jobTitles.join(', ')}`
    );

    // Auto-start the first search (fire-and-forget)
    const chatId = Number(ctx.telegramUser.chatId);
    runSingleSubscriptionSearch(subscription.id)
      .then(async (result) => {
        if (result.notificationsSent > 0) {
          await ctx.api.sendMessage(
            chatId,
            `✅ <b>First scan complete!</b>\n\n` +
              `Found <b>${result.matchesFound}</b> matches.\n` +
              `Sent <b>${result.notificationsSent}</b> notifications.\n\n` +
              'Check above for your job matches!',
            { parse_mode: 'HTML' }
          );
        } else {
          // Build explanation of why no matches
          const { stats, jobsProcessed } = result;
          const reasons: string[] = [];
          if (jobsProcessed === 0) {
            reasons.push('No jobs found for your search criteria');
          } else {
            if (stats.skippedBelowScore > 0) reasons.push(`${stats.skippedBelowScore} below score threshold`);
            if (stats.skippedAlreadySent > 0) reasons.push(`${stats.skippedAlreadySent} already sent`);
            if (stats.skippedCrossSubDuplicates > 0) reasons.push(`${stats.skippedCrossSubDuplicates} matched via other subscription`);
          }

          const reasonText = reasons.length > 0
            ? `\n<i>(${reasons.join(', ')})</i>`
            : '';

          await ctx.api.sendMessage(
            chatId,
            `✅ <b>First scan complete!</b>\n\n` +
              `Processed <b>${jobsProcessed}</b> jobs, no new matches.${reasonText}\n\n` +
              "I'll keep searching every hour and notify you when I find something.",
            { parse_mode: 'HTML' }
          );
        }
      })
      .catch((error) => {
        logger.error('Telegram', `Auto-scan failed for new subscription ${subscription.id}`, error);
      });
  } catch (error) {
    logger.error('Telegram', 'Failed to create subscription', error);
    await ctx.reply(
      'Failed to create subscription. Please try again with /subscribe.'
    );

    // Clear conversation state on error
    await db.telegramUser.update({
      where: { id: ctx.telegramUser.id },
      data: {
        conversationState: undefined,
        conversationData: undefined,
      },
    });
  }
}

// Export for use in document handler
export { createSubscription, getResumeHash };
export type { ConversationData };
