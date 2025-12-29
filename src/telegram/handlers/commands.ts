import { InlineKeyboard } from 'grammy';
import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { getDb } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { runSingleSubscriptionSearch } from '../../scheduler/jobs/search-subscriptions.js';

export function setupCommands(bot: Bot<BotContext>): void {
  // /start - Welcome message with inline keyboard
  bot.command('start', async (ctx) => {
    const firstName = ctx.from?.first_name || 'there';

    const welcomeMessage = `
Hey ${firstName}! 👋 Welcome to <b>AI Job Finder Bot</b>.

I'll help you find jobs that match your skills and notify you automatically when new opportunities appear.

<b>How it works:</b>
1️⃣ Create a subscription with your job preferences
2️⃣ Upload or paste your resume
3️⃣ I'll search hourly and send you matching jobs

Ready to get started?
    `.trim();

    const keyboard = new InlineKeyboard()
      .text('🚀 Create Subscription', 'sub:new')
      .row()
      .text('📋 My Subscriptions', 'sub:list')
      .text('📜 History', 'cmd:history');

    await ctx.reply(welcomeMessage, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // /subscribe - Start subscription flow (allow multiple)
  bot.command('subscribe', async (ctx) => {
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
          'Use /mysubs to manage existing subscriptions.'
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
      '<b>Step 1/6: Job Titles</b>\n\n' +
        'What job titles are you looking for?\n\n' +
        'Send a comma-separated list, e.g.:\n' +
        '<i>"Backend Engineer, Senior Developer, DevOps"</i>',
      { parse_mode: 'HTML' }
    );
  });

  // /mysubs - List all active subscriptions with management UI
  bot.command('mysubs', async (ctx) => {
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
        'No active subscriptions found.\n\nUse /subscribe to create one!'
      );
      return;
    }

    // Build message with subscription list
    let message = `<b>📋 Your Subscriptions (${subs.length})</b>\n\n`;

    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      const status = sub.isPaused ? '⏸️ Paused' : '✅ Active';
      const location = sub.isRemote ? '🌍 Remote' : sub.location || 'Any';

      message += `<b>${i + 1}. ${sub.jobTitles.slice(0, 2).join(', ')}</b>`;
      if (sub.jobTitles.length > 2) message += ` +${sub.jobTitles.length - 2}`;
      message += '\n';
      message += `   ${status} | ${location} | Score ≥${sub.minScore}\n`;
      message += `   📬 ${sub._count.sentNotifications} notifications sent\n\n`;
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

    await ctx.reply(message, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // /status - Shortcut for /mysubs
  bot.command('status', async (ctx) => {
    await ctx.reply('Use /mysubs to view and manage your subscriptions.');
  });

  // /history - View past subscriptions with inline keyboard
  bot.command('history', async (ctx) => {
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
      message += `  📬 ${sub._count.sentNotifications} notifications sent\n\n`;
    }

    await ctx.reply(message, { parse_mode: 'HTML', reply_markup: keyboard });
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
    const location = sub.isRemote ? '🌍 Remote' : sub.location || 'Any';
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

    const message = `
<b>📋 Subscription Details</b>

<b>Status:</b> ${status}
<b>Job Titles:</b> ${sub.jobTitles.join(', ')}
<b>Location:</b> ${location}
<b>Min Score:</b> ${sub.minScore}
<b>Date Range:</b> ${dateRange}

<b>📄 Resume:</b> ${resumeName}
<b>📅 Uploaded:</b> ${resumeDate}

<b>Excluded Titles:</b> ${excludedTitles}
<b>Excluded Companies:</b> ${excludedCompanies}

<b>Stats:</b>
📬 ${sub._count.sentNotifications} notifications sent
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
    keyboard.text('🗑️ Delete', `sub:delete:${sub.id}`);
    keyboard.text('« Back', 'sub:list');

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(message, { parse_mode: 'HTML', reply_markup: keyboard });
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

    let message = `<b>📋 Your Subscriptions (${subs.length})</b>\n\n`;

    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      const status = sub.isPaused ? '⏸️ Paused' : '✅ Active';
      const location = sub.isRemote ? '🌍 Remote' : sub.location || 'Any';

      message += `<b>${i + 1}. ${sub.jobTitles.slice(0, 2).join(', ')}</b>`;
      if (sub.jobTitles.length > 2) message += ` +${sub.jobTitles.length - 2}`;
      message += '\n';
      message += `   ${status} | ${location} | Score ≥${sub.minScore}\n`;
      message += `   📬 ${sub._count.sentNotifications} notifications sent\n\n`;
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
      '<b>Step 1/6: Job Titles</b>\n\n' +
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

    // Answer callback immediately and update message
    await ctx.answerCallbackQuery({ text: '🔍 Starting scan...' });
    await ctx.editMessageText(
      '🔍 <b>Scanning for jobs...</b>\n\n' +
        'This may take a minute. I\'ll send you the results when done.',
      { parse_mode: 'HTML' }
    );

    // Run scan asynchronously (fire-and-forget) to avoid webhook timeout
    runSingleSubscriptionSearch(subId)
      .then(async (result) => {
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
      message += `  📬 ${sub._count.sentNotifications} notifications sent\n\n`;
    }

    await ctx.editMessageText(message, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .text('📋 My Subscriptions', 'sub:list')
        .text('➕ New', 'sub:new'),
    });
  });
}
