import { Bot, Context, webhookCallback } from 'grammy';
import type { Express } from 'express';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getDb } from '../db/client.js';
import { setupCommands } from './handlers/commands.js';
import { setupConversation } from './handlers/conversation.js';
import { setupDocumentHandler } from './services/document.js';

// Extended context with user data
export interface BotContext extends Context {
  telegramUser?: {
    id: string;
    telegramId: bigint;
    chatId: bigint;
    conversationState: string | null;
    conversationData: unknown;
  };
}

let bot: Bot<BotContext> | null = null;

export function getBot(): Bot<BotContext> {
  if (!bot) {
    if (!config.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

    bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN);

    // Middleware to load/create telegram user
    bot.use(async (ctx, next) => {
      if (!ctx.from) {
        return next();
      }

      const db = getDb();
      const telegramId = BigInt(ctx.from.id);
      const chatId = ctx.chat ? BigInt(ctx.chat.id) : telegramId;

      // Upsert user
      const user = await db.telegramUser.upsert({
        where: { telegramId },
        create: {
          telegramId,
          chatId,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
        },
        update: {
          chatId,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastActiveAt: new Date(),
        },
      });

      ctx.telegramUser = {
        id: user.id,
        telegramId: user.telegramId,
        chatId: user.chatId,
        conversationState: user.conversationState,
        conversationData: user.conversationData,
      };

      return next();
    });

    // Logging middleware
    bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      const text = ctx.message?.text?.substring(0, 50) || '[non-text]';
      logger.debug('Telegram', `User ${userId}: ${text}`);
      await next();
    });

    // Register handlers
    setupCommands(bot);
    setupDocumentHandler(bot);
    setupConversation(bot);

    // Error handler
    bot.catch((err) => {
      logger.error('Telegram', 'Bot error', err.error);
    });
  }

  return bot;
}

// Express webhook handler
export function getWebhookHandler() {
  const telegramBot = getBot();
  return webhookCallback(telegramBot, 'express', {
    secretToken: config.TELEGRAM_WEBHOOK_SECRET,
  });
}

// Initialize bot (call from index.ts)
export async function initBot(app: Express): Promise<void> {
  if (!config.TELEGRAM_BOT_TOKEN) {
    logger.info('Telegram', 'Bot disabled (no TELEGRAM_BOT_TOKEN)');
    return;
  }

  const telegramBot = getBot();

  // Test bot connection
  const me = await telegramBot.api.getMe();
  logger.info('Telegram', `Bot connected: @${me.username}`);

  if (config.TELEGRAM_WEBHOOK_URL) {
    // Webhook mode (production)
    app.post('/telegram/webhook', getWebhookHandler());

    await telegramBot.api.setWebhook(config.TELEGRAM_WEBHOOK_URL, {
      secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    });

    logger.info('Telegram', `Webhook set to ${config.TELEGRAM_WEBHOOK_URL}`);
  } else {
    // Polling mode (development)
    telegramBot.start();
    logger.info('Telegram', 'Bot started in polling mode');
  }
}

// Stop bot gracefully
export async function stopBot(): Promise<void> {
  if (bot) {
    await bot.stop();
    bot = null;
    logger.info('Telegram', 'Bot stopped');
  }
}
