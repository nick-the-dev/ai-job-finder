import type { Bot } from 'grammy';
import type { BotContext } from '../bot.js';
import { getDb } from '../../db/client.js';
import { logger } from '../../utils/logger.js';

export function setupCommands(bot: Bot<BotContext>): void {
  // /start - Welcome message
  bot.command('start', async (ctx) => {
    const firstName = ctx.from?.first_name || 'there';

    const welcomeMessage = `
Hey ${firstName}! Welcome to AI Job Finder Bot.

I'll help you find jobs that match your skills and notify you automatically when new opportunities appear.

<b>Commands:</b>
/subscribe - Set up job search subscription
/status - View your current subscription
/pause - Pause notifications
/unpause - Resume notifications
/cancel - Cancel subscription

Ready to get started? Use /subscribe!
    `.trim();

    await ctx.reply(welcomeMessage, { parse_mode: 'HTML' });
  });

  // /subscribe - Start subscription flow
  bot.command('subscribe', async (ctx) => {
    if (!ctx.telegramUser) {
      await ctx.reply('Something went wrong. Please try again.');
      return;
    }

    const db = getDb();

    // Check for existing subscription
    const existingSub = await db.searchSubscription.findFirst({
      where: { userId: ctx.telegramUser.id, isActive: true },
    });

    if (existingSub) {
      await ctx.reply(
        'You already have an active subscription.\n\n' +
          'Use /status to see your current settings, or /cancel to create a new one.'
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
      '<b>Step 1/4: Job Titles</b>\n\n' +
        'What job titles are you looking for?\n\n' +
        'Send a comma-separated list, e.g.:\n' +
        '<i>"Backend Engineer, Senior Developer, DevOps"</i>',
      { parse_mode: 'HTML' }
    );
  });

  // /status - Show current subscription
  bot.command('status', async (ctx) => {
    if (!ctx.telegramUser) {
      await ctx.reply('Something went wrong. Please try again.');
      return;
    }

    const db = getDb();
    const sub = await db.searchSubscription.findFirst({
      where: { userId: ctx.telegramUser.id, isActive: true },
    });

    if (!sub) {
      await ctx.reply(
        'No active subscription found.\n\nUse /subscribe to set one up.'
      );
      return;
    }

    const status = sub.isPaused ? 'Paused' : 'Active';
    const lastSearch = sub.lastSearchAt
      ? sub.lastSearchAt.toLocaleDateString()
      : 'Never';

    const message = `
<b>Your Subscription</b>

<b>Status:</b> ${status}
<b>Job Titles:</b> ${sub.jobTitles.join(', ')}
<b>Location:</b> ${sub.location || 'Any'}
<b>Remote Only:</b> ${sub.isRemote ? 'Yes' : 'No'}
<b>Min Score:</b> ${sub.minScore}

<b>Last Search:</b> ${lastSearch}
<b>Created:</b> ${sub.createdAt.toLocaleDateString()}
    `.trim();

    await ctx.reply(message, { parse_mode: 'HTML' });
  });

  // /pause - Pause notifications
  bot.command('pause', async (ctx) => {
    if (!ctx.telegramUser) {
      await ctx.reply('Something went wrong. Please try again.');
      return;
    }

    const db = getDb();
    const result = await db.searchSubscription.updateMany({
      where: { userId: ctx.telegramUser.id, isActive: true },
      data: { isPaused: true },
    });

    if (result.count === 0) {
      await ctx.reply(
        'No active subscription to pause.\n\nUse /subscribe to set one up.'
      );
      return;
    }

    await ctx.reply(
      'Notifications paused.\n\nUse /unpause to resume receiving job matches.'
    );
    logger.info('Telegram', `User ${ctx.telegramUser.telegramId} paused notifications`);
  });

  // /unpause - Resume notifications
  bot.command('unpause', async (ctx) => {
    if (!ctx.telegramUser) {
      await ctx.reply('Something went wrong. Please try again.');
      return;
    }

    const db = getDb();
    const result = await db.searchSubscription.updateMany({
      where: { userId: ctx.telegramUser.id, isActive: true },
      data: { isPaused: false },
    });

    if (result.count === 0) {
      await ctx.reply(
        'No subscription to unpause.\n\nUse /subscribe to set one up.'
      );
      return;
    }

    await ctx.reply('Notifications resumed! You will now receive job matches.');
    logger.info('Telegram', `User ${ctx.telegramUser.telegramId} unpaused notifications`);
  });

  // /cancel - Cancel subscription
  bot.command('cancel', async (ctx) => {
    if (!ctx.telegramUser) {
      await ctx.reply('Something went wrong. Please try again.');
      return;
    }

    const db = getDb();

    // Also clear any conversation state
    await db.telegramUser.update({
      where: { id: ctx.telegramUser.id },
      data: {
        conversationState: undefined,
        conversationData: undefined,
      },
    });

    const result = await db.searchSubscription.updateMany({
      where: { userId: ctx.telegramUser.id, isActive: true },
      data: { isActive: false },
    });

    if (result.count === 0) {
      await ctx.reply(
        'No active subscription to cancel.\n\nUse /subscribe to set one up.'
      );
      return;
    }

    await ctx.reply(
      'Subscription cancelled.\n\nUse /subscribe to set up a new one anytime.'
    );
    logger.info('Telegram', `User ${ctx.telegramUser.telegramId} cancelled subscription`);
  });
}
