import crypto from 'crypto';
import { InlineKeyboard } from 'grammy';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { getDb } from '../../db/client.js';
import { logger } from '../../utils/logger.js';

interface ConversationData {
  jobTitles?: string[];
  location?: string;
  isRemote?: boolean;
  resumeText?: string;
  resumeName?: string;
  minScore?: number;
  excludedTitles?: string[];
  excludedCompanies?: string[];
}

function getResumeHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
}

export function setupConversation(bot: Bot<BotContext>): void {
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
            '<b>Step 2/6: Location</b>\n\n' +
            'Where should I search for jobs?\n\n' +
            'Options:\n' +
            '- Send <b>"Remote"</b> for remote-only jobs\n' +
            '- Send a location like <b>"USA"</b>, <b>"New York"</b>, <b>"London"</b>\n' +
            '- Send <b>"Skip"</b> for any location',
          { parse_mode: 'HTML' }
        );
        break;
      }

      case 'awaiting_location': {
        let location: string | undefined;
        let isRemote = false;

        const lowerText = text.toLowerCase();
        if (lowerText === 'skip' || lowerText === 'any') {
          location = undefined;
          isRemote = false;
        } else if (lowerText === 'remote') {
          location = undefined;
          isRemote = true;
        } else {
          location = text;
          isRemote = false;
        }

        await db.telegramUser.update({
          where: { id: ctx.telegramUser.id },
          data: {
            conversationState: 'awaiting_resume',
            conversationData: { ...data, location, isRemote },
          },
        });

        const locationText = isRemote
          ? 'Remote only'
          : location
            ? location
            : 'Any location';

        await ctx.reply(
          `<b>Location:</b> ${locationText}\n\n` +
            '<b>Step 3/6: Resume</b>\n\n' +
            'Now I need your resume to match you with jobs.\n\n' +
            'You can:\n' +
            '- <b>Upload</b> a PDF or DOCX file\n' +
            '- <b>Paste</b> your resume text directly here',
          { parse_mode: 'HTML' }
        );
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
            '<b>Step 4/6: Minimum Match Score</b>\n\n' +
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

        // Move to excluded titles step
        await db.telegramUser.update({
          where: { id: ctx.telegramUser.id },
          data: {
            conversationState: 'awaiting_excluded_titles',
            conversationData: { ...data, minScore },
          },
        });

        await ctx.reply(
          `<b>Min Score:</b> ${minScore}\n\n` +
            '<b>Step 5/6: Excluded Job Titles (Optional)</b>\n\n' +
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
            '<b>Step 6/6: Excluded Companies (Optional)</b>\n\n' +
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

        // Create subscription with all data
        const finalData = { ...data, excludedCompanies } as ConversationData;
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

    // Create new subscription (multiple allowed)
    const subscription = await db.searchSubscription.create({
      data: {
        userId: ctx.telegramUser.id,
        jobTitles: data.jobTitles,
        location: data.location,
        isRemote: data.isRemote ?? true,
        minScore: data.minScore ?? 60,
        resumeText: data.resumeText,
        resumeHash,
        resumeName: data.resumeName,
        resumeUploadedAt: new Date(),
        excludedTitles: data.excludedTitles ?? [],
        excludedCompanies: data.excludedCompanies ?? [],
        isActive: true,
        isPaused: false,
      },
    });

    // Clear conversation state
    await db.telegramUser.update({
      where: { id: ctx.telegramUser.id },
      data: {
        conversationState: undefined,
        conversationData: undefined,
      },
    });

    const locationText = data.isRemote
      ? 'Remote only'
      : data.location
        ? data.location
        : 'Any location';

    const excludedTitlesText = data.excludedTitles?.length
      ? data.excludedTitles.join(', ')
      : 'None';
    const excludedCompaniesText = data.excludedCompanies?.length
      ? data.excludedCompanies.join(', ')
      : 'None';

    // Build inline keyboard with scan option
    const keyboard = new InlineKeyboard()
      .text('🔍 Start Scanning Now', `sub:scan:${subscription.id}`)
      .row()
      .text('📋 My Subscriptions', 'sub:list')
      .text('➕ Add Another', 'sub:new');

    await ctx.reply(
      '<b>✅ Subscription created!</b>\n\n' +
        `<b>Job Titles:</b> ${data.jobTitles.join(', ')}\n` +
        `<b>Location:</b> ${locationText}\n` +
        `<b>Min Score:</b> ${data.minScore ?? 60}\n` +
        `<b>Resume:</b> ${data.resumeName || 'Uploaded'}\n` +
        `<b>Excluded Titles:</b> ${excludedTitlesText}\n` +
        `<b>Excluded Companies:</b> ${excludedCompaniesText}\n\n` +
        "I'll search for jobs every hour and notify you when I find matches.\n\n" +
        '<b>Would you like to start scanning now?</b>',
      { parse_mode: 'HTML', reply_markup: keyboard }
    );

    logger.info(
      'Telegram',
      `User ${ctx.telegramUser.telegramId} created subscription: ${data.jobTitles.join(', ')}`
    );
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
