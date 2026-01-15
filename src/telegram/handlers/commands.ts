import { InlineKeyboard, Keyboard } from 'grammy';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';

/**
 * Create the main persistent keyboard that appears at the bottom of the chat.
 * This replaces the need to type commands manually.
 */
function getMainKeyboard(): Keyboard {
  return new Keyboard()
    .text('📋 My Subscriptions').text('➕ New Subscription').row()
    .text('📥 Download All').text('📜 History').row()
    .text('📊 Stats').text('💡 Tips')
    .resized()  // Fit keyboard to content
    .persistent();  // Keep keyboard visible
}
import { getDb } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { runSingleSubscriptionSearch } from '../../scheduler/jobs/search-subscriptions.js';
import { isSubscriptionRunning, markSubscriptionRunning, markSubscriptionFinished } from '../../scheduler/cron.js';
import { saveMatchesToCSV, saveAllSubscriptionsMatchesToCSV, generateDownloadToken, type MatchEntryWithSubscription } from '../../utils/csv.js';
import { config } from '../../config.js';
import { getPersonalStats, getMarketInsights, getResumeTips } from '../../observability/index.js';
import { LocationNormalizerAgent } from '../../agents/location-normalizer.js';
import type { NormalizedLocation } from '../../schemas/llm-outputs.js';

/**
 * Helper function to create a text-based progress bar.
 * @param percent Progress percentage (0-100)
 * @returns Text-based progress bar
 */
function getProgressBar(percent: number): string {
  const filled = Math.round(Math.min(100, Math.max(0, percent)) / 10);
  const empty = 10 - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Format stage name for display.
 */
function formatStageName(stage: string | null): string {
  const stageLabels: Record<string, string> = {
    collection: 'Collecting jobs',
    normalization: 'Deduplicating',
    matching: 'Matching jobs',
    notification: 'Sending results',
    completed: 'Completed',
    starting: 'Starting',
  };
  return stageLabels[stage || 'starting'] || stage || 'In progress';
}

/**
 * Format job types for display.
 * Converts internal values to user-friendly labels.
 */
function formatJobTypesDisplay(jobTypes: string[]): string {
  if (!jobTypes || jobTypes.length === 0) {
    return 'All types';
  }
  const labels: Record<string, string> = {
    fulltime: 'Full-time',
    parttime: 'Part-time',
    internship: 'Internship',
    contract: 'Contract',
  };
  return jobTypes.map((t) => labels[t] || t).join(', ');
}

/**
 * Format location for display in subscription list/details.
 * Uses normalizedLocations if available, falls back to legacy location/isRemote.
 */
function formatLocationDisplay(
  normalizedLocations: unknown,
  legacyLocation: string | null,
  legacyIsRemote: boolean
): string {
  // Try to use normalized locations first
  if (normalizedLocations && Array.isArray(normalizedLocations) && normalizedLocations.length > 0) {
    return LocationNormalizerAgent.formatForDisplaySingleLine(normalizedLocations as NormalizedLocation[]);
  }

  // Fall back to legacy format
  if (legacyIsRemote) {
    return '🌍 Remote';
  }
  return legacyLocation || 'Anywhere';
}

export function setupCommands(bot: Bot<BotContext>): void {
  // /start - Welcome message with persistent keyboard
  bot.command('start', async (ctx) => {
    const firstName = ctx.from?.first_name || 'there';

    const welcomeMessage = `
Hey ${firstName}! 👋 Welcome to <b>AI Job Finder Bot</b>.

I'll help you find jobs that match your skills and notify you automatically when new opportunities appear.

<b>How it works:</b>
1️⃣ Create a subscription with your job preferences
2️⃣ Upload or paste your resume
3️⃣ I'll search hourly and send you matching jobs

Use the buttons below to get started! 👇
    `.trim();

    // Send with persistent keyboard at the bottom of chat
    await ctx.reply(welcomeMessage, { parse_mode: 'HTML', reply_markup: getMainKeyboard() });
  });

  // Handle persistent keyboard button presses (text messages that match button labels)
  bot.hears('📋 My Subscriptions', async (ctx) => {
    // Delegate to the /mysubs logic
    await handleMySubsCommand(ctx);
  });

  bot.hears('➕ New Subscription', async (ctx) => {
    // Delegate to the /subscribe logic
    await handleSubscribeCommand(ctx);
  });

  bot.hears('📥 Download All', async (ctx) => {
    if (!ctx.telegramUser) {
      await ctx.reply('Something went wrong. Please try again.');
      return;
    }
    await downloadAllSubscriptions(ctx);
  });

  bot.hears('📜 History', async (ctx) => {
    await handleHistoryCommand(ctx);
  });

  bot.hears('📊 Stats', async (ctx) => {
    await handleStatsCommand(ctx);
  });

  bot.hears('💡 Tips', async (ctx) => {
    await handleTipsCommand(ctx);
  });

  // /subscribe - Start subscription flow (allow multiple)
  bot.command('subscribe', async (ctx) => {
    await handleSubscribeCommand(ctx);
  });

  // /mysubs - List all active subscriptions with management UI
  bot.command('mysubs', async (ctx) => {
    await handleMySubsCommand(ctx);
  });

  // /status - Shortcut for /mysubs
  bot.command('status', async (ctx) => {
    await ctx.reply('Use /mysubs to view and manage your subscriptions.');
  });

  // /history - View past subscriptions with inline keyboard
  bot.command('history', async (ctx) => {
    await handleHistoryCommand(ctx);
  });

  // Legacy commands - redirect to new UI
  bot.command('pause', async (ctx) => {
    await ctx.reply('Use /mysubs to manage your subscriptions.');
  });

  bot.command('unpause', async (ctx) => {
    await ctx.reply('Use /mysubs to manage your subscriptions.');
  });

  bot.command('cancel', async (ctx) => {
    if (!ctx.telegramUser) {
      await ctx.reply('Something went wrong. Please try again.');
      return;
    }

    const db = getDb();

    // Clear any conversation state
    await db.telegramUser.update({
      where: { id: ctx.telegramUser.id },
      data: {
        conversationState: undefined,
        conversationData: undefined,
      },
    });

    await ctx.reply(
      'Conversation cancelled.\n\nUse /mysubs to manage subscriptions or /subscribe to start fresh.'
    );
  });

  // /clearcache - Clear job query cache (admin command)
  bot.command('clearcache', async (ctx) => {
    const db = getDb();

    try {
      const result = await db.queryCache.deleteMany({});
      logger.info('Telegram', `Cache cleared: ${result.count} entries deleted by user ${ctx.from?.id}`);
      await ctx.reply(`✅ Cache cleared! Deleted ${result.count} cached queries.\n\nNext scan will fetch fresh results.`);
    } catch (error) {
      logger.error('Telegram', 'Failed to clear cache', error);
      await ctx.reply('❌ Failed to clear cache. Please try again.');
    }
  });

  // /downloadall - Download CSV of jobs from all active subscriptions
  bot.command('downloadall', async (ctx) => {
    if (!ctx.telegramUser) {
      await ctx.reply('Something went wrong. Please try again.');
      return;
    }

    await downloadAllSubscriptions(ctx);
  });

  // /stats - Personal performance stats
  bot.command('stats', async (ctx) => {
    await handleStatsCommand(ctx);
  });

  // /market - Job market insights
  bot.command('market', async (ctx) => {
    if (!ctx.telegramUser) {
      await ctx.reply('Something went wrong. Please try again.');
      return;
    }

    const db = getDb();
    const subs = await db.searchSubscription.findMany({
      where: { userId: ctx.telegramUser.id, isActive: true },
      select: { id: true, jobTitles: true, isPaused: true },
    });

    if (subs.length === 0) {
      await ctx.reply(
        'No active subscriptions found.\n\nUse /subscribe to create one and start gathering market insights!',
        { reply_markup: new InlineKeyboard().text('➕ Create Subscription', 'sub:new') }
      );
      return;
    }

    if (subs.length === 1) {
      await showMarketForSubscription(ctx, subs[0].id);
    } else {
      let message = '<b>📈 Select a subscription to view market insights:</b>\n\n';

      const keyboard = new InlineKeyboard();
      for (let i = 0; i < subs.length; i++) {
        const sub = subs[i];
        const label = `${i + 1}. ${sub.jobTitles[0].substring(0, 20)}${sub.isPaused ? ' ⏸️' : ''}`;
        keyboard.text(label, `insight:market:${sub.id}`);
        if ((i + 1) % 2 === 0 || i === subs.length - 1) keyboard.row();
      }
      keyboard.text('📋 My Subscriptions', 'sub:list');

      await ctx.reply(message, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  });

  // /tips - Resume improvement tips
  bot.command('tips', async (ctx) => {
    await handleTipsCommand(ctx);
  });

  // === Callback Query Handlers for Inline Keyboard ===

  // View subscription details
  bot.callbackQuery(/^sub:view:(.+)$/, async (ctx) => {
    const subId = ctx.match[1];
    const db = getDb();

    const sub = await db.searchSubscription.findUnique({
      where: { id: subId },
      include: { _count: { select: { sentNotifications: true } } },
    });

    if (!sub) {
      await ctx.answerCallbackQuery({ text: 'Subscription not found' });
      return;
    }

    const status = sub.isPaused ? '⏸️ Paused' : '✅ Active';
    const location = formatLocationDisplay(sub.normalizedLocations, sub.location, sub.isRemote);
    const lastSearch = sub.lastSearchAt
      ? sub.lastSearchAt.toLocaleDateString()
      : 'Never';

    // Date range labels
    const dateRangeLabels: Record<string, string> = {
      today: 'Last 24 hours',
      '3days': 'Last 3 days',
      week: 'Last week',
      month: 'Last month',
      all: 'All time',
    };
    const dateRange = dateRangeLabels[sub.datePosted] || 'Last month';

    const excludedTitles = sub.excludedTitles?.length
      ? sub.excludedTitles.join(', ')
      : 'None';
    const excludedCompanies = sub.excludedCompanies?.length
      ? sub.excludedCompanies.join(', ')
      : 'None';

    // Resume info
    const resumeName = sub.resumeName || 'Resume';
    const resumeDate = sub.resumeUploadedAt
      ? sub.resumeUploadedAt.toLocaleDateString()
      : sub.createdAt.toLocaleDateString();

    const jobTypesDisplay = formatJobTypesDisplay(sub.jobTypes);

    const message = `
<b>📋 Subscription Details</b>

<b>Status:</b> ${status}
<b>Job Titles:</b> ${sub.jobTitles.join(', ')}
<b>Location:</b> ${location}
<b>Job Types:</b> ${jobTypesDisplay}
<b>Min Score:</b> ${sub.minScore}
<b>Date Range:</b> ${dateRange}

<b>📄 Resume:</b> ${resumeName}
<b>📅 Uploaded:</b> ${resumeDate}

<b>Excluded Titles:</b> ${excludedTitles}
<b>Excluded Companies:</b> ${excludedCompanies}

<b>Stats:</b>
📬 ${sub._count.sentNotifications} matches
🔍 Last search: ${lastSearch}
📅 Created: ${sub.createdAt.toLocaleDateString()}
    `.trim();

    // Build action buttons
    const keyboard = new InlineKeyboard();
    if (!sub.isPaused) {
      keyboard.text('🔍 Scan Now', `sub:scan:${sub.id}`);
    }
    if (sub.isPaused) {
      keyboard.text('▶️ Resume', `sub:unpause:${sub.id}`);
    } else {
      keyboard.text('⏸️ Pause', `sub:pause:${sub.id}`);
    }
    keyboard.row();
    keyboard.text('📊 Insights', `insight:menu:${sub.id}`);
    if (sub._count.sentNotifications > 0) {
      keyboard.text('📥 Download', `sub:download:${sub.id}`);
    }
    keyboard.row();
    keyboard.text('🗑️ Delete', `sub:delete:${sub.id}`);
    keyboard.text('« Back', 'sub:list');

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(message, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // Download all matches for subscription as CSV
  bot.callbackQuery(/^sub:download:(.+)$/, async (ctx) => {
    const subId = ctx.match[1];
    const db = getDb();

    const sub = await db.searchSubscription.findUnique({
      where: { id: subId },
    });

    if (!sub) {
      await ctx.answerCallbackQuery({ text: 'Subscription not found' });
      return;
    }

    // Show loading message
    await ctx.answerCallbackQuery({ text: '📥 Generating CSV...' });
    await ctx.editMessageText(
      '📥 <b>Generating CSV...</b>\n\nPlease wait while I prepare your download.',
      { parse_mode: 'HTML' }
    );

    try {
      // Get all sent notifications for this subscription with job data
      const sentNotifications = await db.sentNotification.findMany({
        where: { subscriptionId: sub.id },
        include: {
          jobMatch: {
            include: { job: true },
          },
        },
        orderBy: { sentAt: 'desc' },
      });

      if (sentNotifications.length === 0) {
        await ctx.editMessageText(
          '📭 <b>No matches found</b>\n\nThis subscription has no job matches yet.',
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard().text('« Back', `sub:view:${subId}`),
          }
        );
        return;
      }

      // Deduplicate by job ID (same job might be matched multiple times)
      const seenJobs = new Set<string>();
      const matches = sentNotifications
        .filter(({ jobMatch }) => {
          if (seenJobs.has(jobMatch.jobId)) return false;
          seenJobs.add(jobMatch.jobId);
          return true;
        })
        .map(({ jobMatch }) => ({
          job: {
            contentHash: jobMatch.job.contentHash,
            title: jobMatch.job.title,
            company: jobMatch.job.company,
            description: jobMatch.job.description,
            location: jobMatch.job.location ?? undefined,
            isRemote: jobMatch.job.isRemote,
            salaryMin: jobMatch.job.salaryMin ?? undefined,
            salaryMax: jobMatch.job.salaryMax ?? undefined,
            salaryCurrency: jobMatch.job.salaryCurrency ?? undefined,
            applicationUrl: jobMatch.job.applicationUrl ?? undefined,
            postedDate: jobMatch.job.postedDate ?? undefined,
            source: jobMatch.job.source as 'serpapi' | 'jobspy',
          },
          match: {
            score: jobMatch.score,
            reasoning: jobMatch.reasoning,
            matchedSkills: jobMatch.matchedSkills,
            missingSkills: jobMatch.missingSkills,
            pros: jobMatch.pros,
            cons: jobMatch.cons,
          },
        }))
        .sort((a, b) => b.match.score - a.match.score);

      // Generate CSV and download token with content stored in database
      const { filename: csvFilename, content: csvContent } = await saveMatchesToCSV(matches);
      const downloadToken = await generateDownloadToken(csvFilename, csvContent);

      const baseUrl = config.APP_URL || `http://localhost:${config.PORT}`;
      const downloadUrl = `${baseUrl}/download/${downloadToken}`;

      await ctx.editMessageText(
        `📥 <b>Download Ready</b>\n\n` +
          `<b>${matches.length}</b> unique job matches from all time.\n\n` +
          `<a href="${downloadUrl}">📄 Download CSV</a>`,
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('« Back', `sub:view:${subId}`),
        }
      );

      logger.info('Telegram', `Generated CSV download for subscription ${subId}: ${matches.length} matches`);
    } catch (error) {
      logger.error('Telegram', `Failed to generate CSV for subscription ${subId}`, error);
      await ctx.editMessageText(
        '❌ <b>Download Failed</b>\n\nSomething went wrong. Please try again later.',
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().text('« Back', `sub:view:${subId}`),
        }
      );
    }
  });

  // Download all matches from all subscriptions as CSV
  bot.callbackQuery('sub:downloadall', async (ctx) => {
    if (!ctx.telegramUser) {
      await ctx.answerCallbackQuery({ text: 'Please try again' });
      return;
    }

    await ctx.answerCallbackQuery({ text: '📥 Generating CSV...' });
    await downloadAllSubscriptions(ctx, true);
  });

  // Pause subscription
  bot.callbackQuery(/^sub:pause:(.+)$/, async (ctx) => {
    const subId = ctx.match[1];
    const db = getDb();

    await db.searchSubscription.update({
      where: { id: subId },
      data: { isPaused: true },
    });

    logger.info('Telegram', `Subscription ${subId} paused via UI`);
    await ctx.answerCallbackQuery({ text: '⏸️ Subscription paused' });

    // Refresh the view
    await ctx.editMessageText(
      '⏸️ <b>Subscription paused</b>\n\nYou won\'t receive notifications until you resume.',
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('▶️ Resume', `sub:unpause:${subId}`)
          .text('« Back', `sub:view:${subId}`),
      }
    );
  });

  // Unpause subscription
  bot.callbackQuery(/^sub:unpause:(.+)$/, async (ctx) => {
    const subId = ctx.match[1];
    const db = getDb();

    await db.searchSubscription.update({
      where: { id: subId },
      data: { isPaused: false },
    });

    logger.info('Telegram', `Subscription ${subId} resumed via UI`);
    await ctx.answerCallbackQuery({ text: '▶️ Subscription resumed!' });

    // Refresh the view
    await ctx.editMessageText(
      '✅ <b>Subscription resumed!</b>\n\nYou\'ll receive notifications for new job matches.',
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('⏸️ Pause', `sub:pause:${subId}`)
          .text('« Back', `sub:view:${subId}`),
      }
    );
  });

  // Delete subscription (soft-delete)
  bot.callbackQuery(/^sub:delete:(.+)$/, async (ctx) => {
    const subId = ctx.match[1];
    const db = getDb();

    // First check if already showing confirmation
    const currentText = ctx.callbackQuery.message?.text || '';
    if (!currentText.includes('Are you sure')) {
      // Show confirmation
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        '⚠️ <b>Delete Subscription?</b>\n\n' +
          'Are you sure you want to delete this subscription?\n' +
          'It will be moved to history and you can view it later.',
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('✅ Yes, Delete', `sub:confirm-delete:${subId}`)
            .text('❌ Cancel', `sub:view:${subId}`),
        }
      );
      return;
    }
  });

  // Confirm delete
  bot.callbackQuery(/^sub:confirm-delete:(.+)$/, async (ctx) => {
    const subId = ctx.match[1];
    const db = getDb();

    const sub = await db.searchSubscription.update({
      where: { id: subId },
      data: { isActive: false },
    });

    logger.info('Telegram', `Subscription ${subId} deleted via UI`);
    await ctx.answerCallbackQuery({ text: '🗑️ Subscription deleted' });

    await ctx.editMessageText(
      '🗑️ <b>Subscription deleted</b>\n\n' +
        `"${sub.jobTitles[0]}" has been moved to history.\n` +
        'Use /history to view past subscriptions.',
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('📋 My Subscriptions', 'sub:list')
          .text('➕ New', 'sub:new'),
      }
    );
  });

  // Back to subscription list
  bot.callbackQuery('sub:list', async (ctx) => {
    if (!ctx.telegramUser) {
      await ctx.answerCallbackQuery({ text: 'Please try again' });
      return;
    }

    const db = getDb();
    const subs = await db.searchSubscription.findMany({
      where: { userId: ctx.telegramUser.id, isActive: true },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { sentNotifications: true } } },
    });

    if (subs.length === 0) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        'No active subscriptions found.\n\nUse /subscribe to create one!',
        { reply_markup: new InlineKeyboard().text('➕ New Subscription', 'sub:new') }
      );
      return;
    }

    // Check for active runs for each subscription
    const activeRuns = await db.subscriptionRun.findMany({
      where: {
        subscriptionId: { in: subs.map((s) => s.id) },
        status: 'running',
      },
      select: {
        subscriptionId: true,
        currentStage: true,
        progressPercent: true,
        progressDetail: true,
      },
    });
    const activeRunMap = new Map(activeRuns.map((r) => [r.subscriptionId, r]));

    let message = `<b>📋 Your Subscriptions (${subs.length})</b>\n\n`;

    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      const activeRun = activeRunMap.get(sub.id);
      const location = formatLocationDisplay(sub.normalizedLocations, sub.location, sub.isRemote);

      message += `<b>${i + 1}. ${sub.jobTitles.slice(0, 2).join(', ')}</b>`;
      if (sub.jobTitles.length > 2) message += ` +${sub.jobTitles.length - 2}`;
      message += '\n';

      // Show progress if running, otherwise show status
      if (activeRun) {
        const progress = activeRun.progressPercent ?? 0;
        const progressBar = getProgressBar(progress);
        const stageName = formatStageName(activeRun.currentStage);
        message += `   🔄 <b>Running:</b> ${progressBar} ${progress}%\n`;
        message += `   ${stageName}\n`;
      } else {
        const status = sub.isPaused ? '⏸️ Paused' : '✅ Active';
        message += `   ${status} | 📍 ${location} | Score ≥${sub.minScore}\n`;
        message += `   💼 ${formatJobTypesDisplay(sub.jobTypes)}\n`;
      }
      message += `   📬 ${sub._count.sentNotifications} matches\n\n`;
    }

    message += 'Select a subscription to manage:';

    const keyboard = new InlineKeyboard();
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      const label = `${i + 1}. ${sub.jobTitles[0].substring(0, 20)}${sub.isPaused ? ' ⏸️' : ''}`;
      keyboard.text(label, `sub:view:${sub.id}`);
      if ((i + 1) % 2 === 0 || i === subs.length - 1) keyboard.row();
    }
    keyboard.text('➕ New Subscription', 'sub:new');
    // Check if any subscription has matches before showing download button
    const totalMatches = subs.reduce((sum, s) => sum + s._count.sentNotifications, 0);
    if (totalMatches > 0) {
      keyboard.text('📥 Download All', 'sub:downloadall');
    }

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(message, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // New subscription from button
  bot.callbackQuery('sub:new', async (ctx) => {
    if (!ctx.telegramUser) {
      await ctx.answerCallbackQuery({ text: 'Please try again' });
      return;
    }

    const db = getDb();

    const activeCount = await db.searchSubscription.count({
      where: { userId: ctx.telegramUser.id, isActive: true },
    });

    if (activeCount >= 5) {
      await ctx.answerCallbackQuery({ text: 'Max 5 subscriptions reached' });
      return;
    }

    await db.telegramUser.update({
      where: { id: ctx.telegramUser.id },
      data: {
        conversationState: 'awaiting_titles',
        conversationData: {},
      },
    });

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      '<b>Step 1/9: Job Titles</b>\n\n' +
        'What job titles are you looking for?\n\n' +
        'Send a comma-separated list, e.g.:\n' +
        '<i>"Backend Engineer, Senior Developer, DevOps"</i>',
      { parse_mode: 'HTML' }
    );
  });

  // Scan subscription now (manual trigger) - runs asynchronously to avoid webhook timeout
  bot.callbackQuery(/^sub:scan:(.+)$/, async (ctx) => {
    const subId = ctx.match[1];
    const db = getDb();

    const sub = await db.searchSubscription.findUnique({
      where: { id: subId },
      include: { user: true },
    });

    if (!sub || !sub.isActive) {
      await ctx.answerCallbackQuery({ text: 'Subscription not found' });
      return;
    }

    if (sub.isPaused) {
      await ctx.answerCallbackQuery({ text: 'Subscription is paused. Resume it first.' });
      return;
    }

    const chatId = Number(sub.user.chatId);

    // Check if subscription is already running (prevents concurrent runs)
    if (await isSubscriptionRunning(subId)) {
      await ctx.answerCallbackQuery({ text: '⏳ A scan is already in progress for this subscription' });
      await ctx.editMessageText(
        '⏳ <b>Scan Already Running</b>\n\n' +
          'A scan is already in progress for this subscription.\n' +
          'Please wait for it to complete.',
        {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('« Back', `sub:detail:${subId}`),
        }
      );
      return;
    }

    // Acquire lock before starting
    const lockAcquired = await markSubscriptionRunning(subId);
    if (!lockAcquired) {
      await ctx.answerCallbackQuery({ text: '⏳ Already running...' });
      return;
    }

    // Answer callback immediately and update message
    await ctx.answerCallbackQuery({ text: '🔍 Starting scan...' });
    await ctx.editMessageText(
      '🔍 <b>Scanning for jobs...</b>\n\n' +
        'This may take a minute. I\'ll send you the results when done.',
      { parse_mode: 'HTML' }
    );

    // Run scan asynchronously (fire-and-forget) to avoid webhook timeout
    runSingleSubscriptionSearch(subId, 'manual')
      .then(async (result) => {
        await markSubscriptionFinished(subId);

        const keyboard = new InlineKeyboard()
          .text('📋 My Subscriptions', 'sub:list')
          .text('🔍 Scan Again', `sub:scan:${subId}`);

        if (result.notificationsSent > 0) {
          await ctx.api.sendMessage(
            chatId,
            `✅ <b>Scan Complete!</b>\n\n` +
              `Found <b>${result.matchesFound}</b> new matches.\n` +
              `Sent <b>${result.notificationsSent}</b> notifications.\n\n` +
              'Check above for your job matches!',
            { parse_mode: 'HTML', reply_markup: keyboard }
          );
        } else {
          await ctx.api.sendMessage(
            chatId,
            `✅ <b>Scan Complete!</b>\n\n` +
              `No new matches found at this time.\n\n` +
              'I\'ll keep searching hourly and notify you when I find something.',
            { parse_mode: 'HTML', reply_markup: keyboard }
          );
        }

        logger.info('Telegram', `Manual scan completed for subscription ${subId}: ${result.matchesFound} matches`);
      })
      .catch(async (error) => {
        await markSubscriptionFinished(subId);
        logger.error('Telegram', `Manual scan failed for subscription ${subId}`, error);

        await ctx.api.sendMessage(
          chatId,
          '❌ <b>Scan Failed</b>\n\n' +
            'Something went wrong. Please try again later.',
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard()
              .text('🔄 Retry', `sub:scan:${subId}`)
              .text('« Back', 'sub:list'),
          }
        );
      });
  });

  // History command via callback
  bot.callbackQuery('cmd:history', async (ctx) => {
    if (!ctx.telegramUser) {
      await ctx.answerCallbackQuery({ text: 'Please try again' });
      return;
    }

    const db = getDb();
    const pastSubs = await db.searchSubscription.findMany({
      where: { userId: ctx.telegramUser.id, isActive: false },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      include: { _count: { select: { sentNotifications: true } } },
    });

    await ctx.answerCallbackQuery();

    if (pastSubs.length === 0) {
      await ctx.editMessageText(
        'No past subscriptions found.\n\nYour cancelled subscriptions will appear here.',
        {
          reply_markup: new InlineKeyboard()
            .text('📋 My Subscriptions', 'sub:list')
            .text('➕ New', 'sub:new'),
        }
      );
      return;
    }

    let message = '<b>📜 Past Subscriptions</b>\n\n';

    for (const sub of pastSubs) {
      const location = sub.isRemote ? 'Remote' : sub.location || 'Any';
      const ended = sub.updatedAt.toLocaleDateString();

      message += `• <b>${sub.jobTitles.slice(0, 2).join(', ')}</b>\n`;
      message += `  ${location} | Ended: ${ended}\n`;
      message += `  📬 ${sub._count.sentNotifications} matches\n\n`;
    }

    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('📋 My Subscriptions', 'sub:list')
        .text('➕ New', 'sub:new'),
    });
  });

  // === Insight Callback Handlers ===

  // Stats for specific subscription
  bot.callbackQuery(/^insight:stats:(.+)$/, async (ctx) => {
    const subId = ctx.match[1];
    await ctx.answerCallbackQuery();
    await showStatsForSubscription(ctx, subId, true);
  });

  // Market insights for specific subscription
  bot.callbackQuery(/^insight:market:(.+)$/, async (ctx) => {
    const subId = ctx.match[1];
    await ctx.answerCallbackQuery();
    await showMarketForSubscription(ctx, subId, true);
  });

  // Tips for specific subscription
  bot.callbackQuery(/^insight:tips:(.+)$/, async (ctx) => {
    const subId = ctx.match[1];
    await ctx.answerCallbackQuery();
    await showTipsForSubscription(ctx, subId, true);
  });

  // Insights menu for subscription
  bot.callbackQuery(/^insight:menu:(.+)$/, async (ctx) => {
    const subId = ctx.match[1];
    await ctx.answerCallbackQuery();

    const db = getDb();
    const sub = await db.searchSubscription.findUnique({
      where: { id: subId },
      select: { jobTitles: true },
    });

    if (!sub) return;

    const message = `<b>📊 Insights: ${sub.jobTitles[0]}</b>\n\nWhat would you like to see?`;

    const keyboard = new InlineKeyboard()
      .text('📊 My Stats', `insight:stats:${subId}`)
      .text('📈 Market', `insight:market:${subId}`)
      .row()
      .text('💡 Resume Tips', `insight:tips:${subId}`)
      .row()
      .text('« Back to Subscription', `sub:view:${subId}`);

    await ctx.editMessageText(message, { parse_mode: 'HTML', reply_markup: keyboard });
  });
}

// Helper function to show stats for a subscription
async function showStatsForSubscription(
  ctx: BotContext,
  subscriptionId: string,
  isEdit = false
): Promise<void> {
  const stats = await getPersonalStats(subscriptionId);

  if (!stats) {
    const message = 'No stats available yet. Run a scan first!';
    const keyboard = new InlineKeyboard().text('📋 My Subscriptions', 'sub:list');
    if (isEdit) {
      await ctx.editMessageText(message, { reply_markup: keyboard });
    } else {
      await ctx.reply(message, { reply_markup: keyboard });
    }
    return;
  }

  // Format activity sparkline (last 7 days)
  const activityDays = stats.activity.slice(-7);
  const maxJobs = Math.max(...activityDays.map(d => d.jobs), 1);
  const sparkline = activityDays.map(d => {
    const ratio = d.jobs / maxJobs;
    if (ratio > 0.75) return '█';
    if (ratio > 0.5) return '▆';
    if (ratio > 0.25) return '▃';
    if (ratio > 0) return '▁';
    return '·';
  }).join('');

  let message = `<b>📊 Your Performance Stats</b>\n\n`;

  message += `<b>Search:</b> ${stats.subscription.jobTitles.slice(0, 2).join(', ')}\n`;
  message += `<b>Min Score:</b> ${stats.subscription.minScore}\n\n`;

  message += `<b>📈 Last 7 Days</b>\n`;
  message += `Jobs scanned: <b>${stats.summary.totalJobsScanned}</b>\n`;
  message += `Matches found: <b>${stats.summary.totalMatches}</b>\n`;
  message += `Match rate: <b>${stats.summary.matchRate}%</b>\n`;
  message += `Avg score: <b>${stats.summary.avgScore}</b>\n`;
  message += `Notifications: <b>${stats.summary.notificationsSent}</b>\n\n`;

  message += `<b>📊 Score Distribution</b>\n`;
  message += `🟢 Excellent (90+): ${stats.scoreDistribution.excellent}\n`;
  message += `🔵 Strong (70-89): ${stats.scoreDistribution.strong}\n`;
  message += `🟡 Moderate (50-69): ${stats.scoreDistribution.moderate}\n`;
  message += `🔴 Weak (<50): ${stats.scoreDistribution.weak}\n\n`;

  if (stats.skills.topMatched.length > 0) {
    message += `<b>✅ Top Matched Skills</b>\n`;
    message += stats.skills.topMatched.map(s => `• ${s}`).join('\n') + '\n\n';
  }

  if (stats.skills.topMissing.length > 0) {
    message += `<b>⚠️ Commonly Missing</b>\n`;
    message += stats.skills.topMissing.map(s => `• ${s}`).join('\n') + '\n\n';
  }

  message += `<b>📅 Activity (7d):</b> <code>${sparkline}</code>`;

  const keyboard = new InlineKeyboard()
    .text('📈 Market', `insight:market:${subscriptionId}`)
    .text('💡 Tips', `insight:tips:${subscriptionId}`)
    .row()
    .text('« Subscription', `sub:view:${subscriptionId}`)
    .text('📋 All Subs', 'sub:list');

  if (isEdit) {
    await ctx.editMessageText(message, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

// Helper function to show market insights for a subscription
async function showMarketForSubscription(
  ctx: BotContext,
  subscriptionId: string,
  isEdit = false
): Promise<void> {
  const insights = await getMarketInsights(subscriptionId);

  if (!insights) {
    const message = 'No market data available yet. Run a scan to collect data!';
    const keyboard = new InlineKeyboard().text('📋 My Subscriptions', 'sub:list');
    if (isEdit) {
      await ctx.editMessageText(message, { reply_markup: keyboard });
    } else {
      await ctx.reply(message, { reply_markup: keyboard });
    }
    return;
  }

  let message = `<b>📈 Job Market Insights</b>\n\n`;

  // Salary info
  if (insights.salary.min || insights.salary.max) {
    const formatSalary = (n: number) => `$${Math.round(n / 1000)}k`;
    if (insights.salary.min && insights.salary.max) {
      message += `<b>💰 Avg Salary Range</b>\n`;
      message += `${formatSalary(insights.salary.min)} - ${formatSalary(insights.salary.max)}\n\n`;
    }
  }

  message += `<b>🌍 Remote Jobs:</b> ${insights.remoteRatio}%\n`;
  message += `<b>📊 Total Jobs:</b> ${insights.totalJobs}\n\n`;

  // Top companies
  if (insights.topCompanies && insights.topCompanies.length > 0) {
    message += `<b>🏢 Top Hiring Companies</b>\n`;
    for (const { company, count } of insights.topCompanies.slice(0, 5)) {
      message += `• ${company} (${count})\n`;
    }
    message += '\n';
  }

  // Top skills (if available)
  if ('topSkills' in insights && insights.topSkills && (insights.topSkills as Array<{skill: string, count: number}>).length > 0) {
    message += `<b>🔧 In-Demand Skills</b>\n`;
    for (const { skill, count } of (insights.topSkills as Array<{skill: string, count: number}>).slice(0, 8)) {
      message += `• ${skill} (${count})\n`;
    }
    message += '\n';
  }

  // Top locations (if available)
  if ('topLocations' in insights && insights.topLocations && (insights.topLocations as Array<{location: string, count: number}>).length > 0) {
    message += `<b>📍 Top Locations</b>\n`;
    for (const { location, count } of (insights.topLocations as Array<{location: string, count: number}>).slice(0, 5)) {
      message += `• ${location} (${count})\n`;
    }
    message += '\n';
  }

  const sourceLabel = insights.dataSource === 'snapshot' ? 'Market snapshot' : 'Live data';
  message += `<i>Source: ${sourceLabel}</i>`;

  const keyboard = new InlineKeyboard()
    .text('📊 Stats', `insight:stats:${subscriptionId}`)
    .text('💡 Tips', `insight:tips:${subscriptionId}`)
    .row()
    .text('« Subscription', `sub:view:${subscriptionId}`)
    .text('📋 All Subs', 'sub:list');

  if (isEdit) {
    await ctx.editMessageText(message, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

// Helper function to show resume tips for a subscription
async function showTipsForSubscription(
  ctx: BotContext,
  subscriptionId: string,
  isEdit = false
): Promise<void> {
  const tips = await getResumeTips(subscriptionId);

  if (!tips) {
    const message = 'No tips available yet. Run some scans to collect match data!';
    const keyboard = new InlineKeyboard().text('📋 My Subscriptions', 'sub:list');
    if (isEdit) {
      await ctx.editMessageText(message, { reply_markup: keyboard });
    } else {
      await ctx.reply(message, { reply_markup: keyboard });
    }
    return;
  }

  let message = `<b>💡 Resume Improvement Tips</b>\n\n`;

  // Score comparison
  const scoreDiff = tips.avgScore - tips.platformAvgScore;
  const scoreEmoji = scoreDiff >= 5 ? '🟢' : scoreDiff >= -5 ? '🟡' : '🔴';
  message += `<b>📊 Your Performance</b>\n`;
  message += `${scoreEmoji} Your avg score: <b>${tips.avgScore}</b>\n`;
  message += `Platform avg: ${tips.platformAvgScore}\n`;
  message += `Based on ${tips.matchCount} job matches\n\n`;

  // Skill gaps
  if (tips.skillGaps.length > 0) {
    message += `<b>⚠️ Skills to Add</b>\n`;
    message += `<i>Frequently requested but missing from your resume:</i>\n\n`;
    for (const gap of tips.skillGaps) {
      const priority = gap.missingPercent > 70 ? '🔴' : gap.missingPercent > 40 ? '🟡' : '🟢';
      message += `${priority} <b>${gap.skill}</b> - ${gap.missingPercent}% of jobs\n`;
    }
    message += '\n';
  }

  // Top matched (positive reinforcement)
  if (tips.topMatched.length > 0) {
    message += `<b>✅ Your Strengths</b>\n`;
    message += `These skills are matching well:\n`;
    message += tips.topMatched.map(s => `• ${s}`).join('\n') + '\n\n';
  }

  // Action tips
  if (tips.tips.length > 0) {
    message += `<b>📝 Recommendations</b>\n`;
    for (const tip of tips.tips.filter(t => t.type !== 'score_comparison').slice(0, 3)) {
      const icon = tip.priority === 'high' ? '🔴' : tip.priority === 'medium' ? '🟡' : '💬';
      message += `${icon} ${tip.message}\n\n`;
    }
  }

  const keyboard = new InlineKeyboard()
    .text('📊 Stats', `insight:stats:${subscriptionId}`)
    .text('📈 Market', `insight:market:${subscriptionId}`)
    .row()
    .text('« Subscription', `sub:view:${subscriptionId}`)
    .text('📋 All Subs', 'sub:list');

  if (isEdit) {
    await ctx.editMessageText(message, { parse_mode: 'HTML', reply_markup: keyboard });
  } else {
    await ctx.reply(message, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

// Helper function to download all subscriptions matches as CSV
async function downloadAllSubscriptions(
  ctx: BotContext,
  isEdit = false
): Promise<void> {
  const db = getDb();

  if (!ctx.telegramUser) {
    return;
  }

  // Show loading message
  const loadingMessage = '📥 <b>Generating CSV...</b>\n\nPlease wait while I prepare your download.';
  if (isEdit) {
    await ctx.editMessageText(loadingMessage, { parse_mode: 'HTML' });
  } else {
    await ctx.reply(loadingMessage, { parse_mode: 'HTML' });
  }

  try {
    // Get all active subscriptions for the user
    const subs = await db.searchSubscription.findMany({
      where: { userId: ctx.telegramUser.id, isActive: true },
      select: { id: true, jobTitles: true },
    });

    if (subs.length === 0) {
      const noSubsMessage = '📭 <b>No subscriptions found</b>\n\nCreate a subscription first to start collecting job matches.';
      const keyboard = new InlineKeyboard().text('➕ Create Subscription', 'sub:new');
      if (isEdit) {
        await ctx.editMessageText(noSubsMessage, { parse_mode: 'HTML', reply_markup: keyboard });
      } else {
        await ctx.reply(noSubsMessage, { parse_mode: 'HTML', reply_markup: keyboard });
      }
      return;
    }

    // Get all sent notifications for all subscriptions with job data
    const sentNotifications = await db.sentNotification.findMany({
      where: { subscriptionId: { in: subs.map((s) => s.id) } },
      include: {
        subscription: { select: { jobTitles: true } },
        jobMatch: {
          include: { job: true },
        },
      },
      orderBy: { sentAt: 'desc' },
    });

    if (sentNotifications.length === 0) {
      const noMatchesMessage = '📭 <b>No matches found</b>\n\nYour subscriptions have no job matches yet. Run a scan to find jobs!';
      const keyboard = new InlineKeyboard().text('📋 My Subscriptions', 'sub:list');
      if (isEdit) {
        await ctx.editMessageText(noMatchesMessage, { parse_mode: 'HTML', reply_markup: keyboard });
      } else {
        await ctx.reply(noMatchesMessage, { parse_mode: 'HTML', reply_markup: keyboard });
      }
      return;
    }

    // Deduplicate by job ID (same job might be matched multiple times)
    const seenJobs = new Set<string>();
    const matches: MatchEntryWithSubscription[] = sentNotifications
      .filter(({ jobMatch }) => {
        if (seenJobs.has(jobMatch.jobId)) return false;
        seenJobs.add(jobMatch.jobId);
        return true;
      })
      .map(({ jobMatch, subscription }) => ({
        subscriptionName: subscription.jobTitles.slice(0, 2).join(', '),
        job: {
          contentHash: jobMatch.job.contentHash,
          title: jobMatch.job.title,
          company: jobMatch.job.company,
          description: jobMatch.job.description,
          location: jobMatch.job.location ?? undefined,
          isRemote: jobMatch.job.isRemote,
          salaryMin: jobMatch.job.salaryMin ?? undefined,
          salaryMax: jobMatch.job.salaryMax ?? undefined,
          salaryCurrency: jobMatch.job.salaryCurrency ?? undefined,
          applicationUrl: jobMatch.job.applicationUrl ?? undefined,
          postedDate: jobMatch.job.postedDate ?? undefined,
          source: jobMatch.job.source as 'serpapi' | 'jobspy',
        },
        match: {
          score: jobMatch.score,
          reasoning: jobMatch.reasoning,
          matchedSkills: jobMatch.matchedSkills,
          missingSkills: jobMatch.missingSkills,
          pros: jobMatch.pros,
          cons: jobMatch.cons,
        },
      }))
      .sort((a, b) => b.match.score - a.match.score);

    // Generate CSV and download token with content stored in database
    const { filename: csvFilename, content: csvContent } = await saveAllSubscriptionsMatchesToCSV(matches);
    const downloadToken = await generateDownloadToken(csvFilename, csvContent);

    const baseUrl = config.APP_URL || `http://localhost:${config.PORT}`;
    const downloadUrl = `${baseUrl}/download/${downloadToken}`;

    const successMessage =
      `📥 <b>Download Ready</b>\n\n` +
      `<b>${matches.length}</b> unique job matches from <b>${subs.length}</b> subscription${subs.length > 1 ? 's' : ''}.\n\n` +
      `<a href="${downloadUrl}">📄 Download CSV</a>`;

    const keyboard = new InlineKeyboard().text('📋 My Subscriptions', 'sub:list');
    if (isEdit) {
      await ctx.editMessageText(successMessage, { parse_mode: 'HTML', reply_markup: keyboard });
    } else {
      await ctx.reply(successMessage, { parse_mode: 'HTML', reply_markup: keyboard });
    }

    logger.info('Telegram', `Generated CSV download for all subscriptions (user ${ctx.telegramUser.id}): ${matches.length} matches`);
  } catch (error) {
    logger.error('Telegram', `Failed to generate CSV for all subscriptions (user ${ctx.telegramUser?.id})`, error);
    const errorMessage = '❌ <b>Download Failed</b>\n\nSomething went wrong. Please try again later.';
    const keyboard = new InlineKeyboard().text('📋 My Subscriptions', 'sub:list');
    if (isEdit) {
      await ctx.editMessageText(errorMessage, { parse_mode: 'HTML', reply_markup: keyboard });
    } else {
      await ctx.reply(errorMessage, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  }
}

// === Helper functions for keyboard button handlers ===

// Handle My Subscriptions (from keyboard button or /mysubs command)
async function handleMySubsCommand(ctx: BotContext): Promise<void> {
  if (!ctx.telegramUser) {
    await ctx.reply('Something went wrong. Please try again.');
    return;
  }

  const db = getDb();
  const subs = await db.searchSubscription.findMany({
    where: { userId: ctx.telegramUser.id, isActive: true },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { sentNotifications: true } } },
  });

  if (subs.length === 0) {
    await ctx.reply(
      'No active subscriptions found.\n\nUse the "➕ New Subscription" button to create one!'
    );
    return;
  }

  // Check for active runs for each subscription
  const activeRuns = await db.subscriptionRun.findMany({
    where: {
      subscriptionId: { in: subs.map((s) => s.id) },
      status: 'running',
    },
    select: {
      subscriptionId: true,
      currentStage: true,
      progressPercent: true,
      progressDetail: true,
    },
  });
  const activeRunMap = new Map(activeRuns.map((r) => [r.subscriptionId, r]));

  // Build message with subscription list
  let message = `<b>📋 Your Subscriptions (${subs.length})</b>\n\n`;

  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    const activeRun = activeRunMap.get(sub.id);
    const location = formatLocationDisplay(sub.normalizedLocations, sub.location, sub.isRemote);

    message += `<b>${i + 1}. ${sub.jobTitles.slice(0, 2).join(', ')}</b>`;
    if (sub.jobTitles.length > 2) message += ` +${sub.jobTitles.length - 2}`;
    message += '\n';

    // Show progress if running, otherwise show status
    if (activeRun) {
      const progress = activeRun.progressPercent ?? 0;
      const progressBar = getProgressBar(progress);
      const stageName = formatStageName(activeRun.currentStage);
      message += `   🔄 <b>Running:</b> ${progressBar} ${progress}%\n`;
      message += `   ${stageName}\n`;
    } else {
      const status = sub.isPaused ? '⏸️ Paused' : '✅ Active';
      message += `   ${status} | 📍 ${location} | Score ≥${sub.minScore}\n`;
      message += `   💼 ${formatJobTypesDisplay(sub.jobTypes)}\n`;
    }
    message += `   📬 ${sub._count.sentNotifications} matches\n\n`;
  }

  message += 'Select a subscription to manage:';

  // Build inline keyboard with subscription buttons
  const keyboard = new InlineKeyboard();
  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    const label = `${i + 1}. ${sub.jobTitles[0].substring(0, 20)}${sub.isPaused ? ' ⏸️' : ''}`;
    keyboard.text(label, `sub:view:${sub.id}`);
    if ((i + 1) % 2 === 0 || i === subs.length - 1) keyboard.row();
  }
  keyboard.text('➕ New Subscription', 'sub:new');
  // Check if any subscription has matches before showing download button
  const totalMatches = subs.reduce((sum, s) => sum + s._count.sentNotifications, 0);
  if (totalMatches > 0) {
    keyboard.text('📥 Download All', 'sub:downloadall');
  }

  await ctx.reply(message, { parse_mode: 'HTML', reply_markup: keyboard });
}

// Handle New Subscription (from keyboard button or /subscribe command)
async function handleSubscribeCommand(ctx: BotContext): Promise<void> {
  if (!ctx.telegramUser) {
    await ctx.reply('Something went wrong. Please try again.');
    return;
  }

  const db = getDb();

  // Count active subscriptions
  const activeCount = await db.searchSubscription.count({
    where: { userId: ctx.telegramUser.id, isActive: true },
  });

  if (activeCount >= 5) {
    await ctx.reply(
      'You have reached the maximum of 5 active subscriptions.\n\n' +
        'Use "📋 My Subscriptions" to manage existing subscriptions.'
    );
    return;
  }

  // Update conversation state
  await db.telegramUser.update({
    where: { id: ctx.telegramUser.id },
    data: {
      conversationState: 'awaiting_titles',
      conversationData: {},
    },
  });

  await ctx.reply(
    '<b>Step 1/9: Job Titles</b>\n\n' +
      'What job titles are you looking for?\n\n' +
      'Send a comma-separated list, e.g.:\n' +
      '<i>"Backend Engineer, Senior Developer, DevOps"</i>',
    { parse_mode: 'HTML' }
  );
}

// Handle History (from keyboard button or /history command)
async function handleHistoryCommand(ctx: BotContext): Promise<void> {
  if (!ctx.telegramUser) {
    await ctx.reply('Something went wrong. Please try again.');
    return;
  }

  const db = getDb();
  const pastSubs = await db.searchSubscription.findMany({
    where: { userId: ctx.telegramUser.id, isActive: false },
    orderBy: { updatedAt: 'desc' },
    take: 10,
    include: { _count: { select: { sentNotifications: true } } },
  });

  const keyboard = new InlineKeyboard()
    .text('📋 My Subscriptions', 'sub:list')
    .text('➕ New', 'sub:new');

  if (pastSubs.length === 0) {
    await ctx.reply(
      'No past subscriptions found.\n\nYour cancelled subscriptions will appear here.',
      { reply_markup: keyboard }
    );
    return;
  }

  let message = '<b>📜 Past Subscriptions</b>\n\n';

  for (const sub of pastSubs) {
    const location = sub.isRemote ? 'Remote' : sub.location || 'Any';
    const ended = sub.updatedAt.toLocaleDateString();

    message += `• <b>${sub.jobTitles.slice(0, 2).join(', ')}</b>\n`;
    message += `  ${location} | Ended: ${ended}\n`;
    message += `  📬 ${sub._count.sentNotifications} matches\n\n`;
  }

  await ctx.reply(message, { parse_mode: 'HTML', reply_markup: keyboard });
}

// Handle Stats (from keyboard button or /stats command)
async function handleStatsCommand(ctx: BotContext): Promise<void> {
  if (!ctx.telegramUser) {
    await ctx.reply('Something went wrong. Please try again.');
    return;
  }

  const db = getDb();
  const subs = await db.searchSubscription.findMany({
    where: { userId: ctx.telegramUser.id, isActive: true },
    select: { id: true, jobTitles: true, isPaused: true },
  });

  if (subs.length === 0) {
    await ctx.reply(
      'No active subscriptions found.\n\nUse "➕ New Subscription" to create one and start tracking stats!',
      { reply_markup: new InlineKeyboard().text('➕ Create Subscription', 'sub:new') }
    );
    return;
  }

  if (subs.length === 1) {
    // Single subscription - show stats directly
    await showStatsForSubscription(ctx, subs[0].id);
  } else {
    // Multiple subscriptions - show picker
    let message = '<b>📊 Select a subscription to view stats:</b>\n\n';

    const keyboard = new InlineKeyboard();
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      const label = `${i + 1}. ${sub.jobTitles[0].substring(0, 20)}${sub.isPaused ? ' ⏸️' : ''}`;
      keyboard.text(label, `insight:stats:${sub.id}`);
      if ((i + 1) % 2 === 0 || i === subs.length - 1) keyboard.row();
    }
    keyboard.text('📋 My Subscriptions', 'sub:list');

    await ctx.reply(message, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}

// Handle Tips (from keyboard button or /tips command)
async function handleTipsCommand(ctx: BotContext): Promise<void> {
  if (!ctx.telegramUser) {
    await ctx.reply('Something went wrong. Please try again.');
    return;
  }

  const db = getDb();
  const subs = await db.searchSubscription.findMany({
    where: { userId: ctx.telegramUser.id, isActive: true },
    select: { id: true, jobTitles: true, isPaused: true },
  });

  if (subs.length === 0) {
    await ctx.reply(
      'No active subscriptions found.\n\nUse "➕ New Subscription" to create one and I\'ll analyze your matches for tips!',
      { reply_markup: new InlineKeyboard().text('➕ Create Subscription', 'sub:new') }
    );
    return;
  }

  if (subs.length === 1) {
    await showTipsForSubscription(ctx, subs[0].id);
  } else {
    let message = '<b>💡 Select a subscription to get resume tips:</b>\n\n';

    const keyboard = new InlineKeyboard();
    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      const label = `${i + 1}. ${sub.jobTitles[0].substring(0, 20)}${sub.isPaused ? ' ⏸️' : ''}`;
      keyboard.text(label, `insight:tips:${sub.id}`);
      if ((i + 1) % 2 === 0 || i === subs.length - 1) keyboard.row();
    }
    keyboard.text('📋 My Subscriptions', 'sub:list');

    await ctx.reply(message, { parse_mode: 'HTML', reply_markup: keyboard });
  }
}
