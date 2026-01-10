import { Bot, Context, webhookCallback } from 'grammy';
import type { Express, Request, Response, NextFunction } from 'express';
import * as Sentry from '@sentry/node';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getDb } from '../db/client.js';
import { setupCommands } from './handlers/commands.js';
import { setupConversation } from './handlers/conversation.js';
import { setupDocumentHandler } from './services/document.js';

// Webhook health check interval (5 minutes)
const WEBHOOK_CHECK_INTERVAL_MS = 5 * 60 * 1000;
let webhookCheckInterval: NodeJS.Timeout | null = null;

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

    // Error handler with Sentry integration
    bot.catch((err) => {
      const error = err.error instanceof Error ? err.error : new Error(String(err.error));
      const ctx = err.ctx;

      // Capture to Sentry with user context
      Sentry.captureException(error, {
        tags: {
          handler: 'telegramBot',
          command: ctx.message?.text?.split(' ')[0] || 'unknown',
        },
        user: ctx.from ? {
          id: ctx.from.id.toString(),
          username: ctx.from.username,
        } : undefined,
        extra: {
          chatId: ctx.chat?.id,
          updateType: ctx.update ? Object.keys(ctx.update)[0] : 'unknown',
        },
      });

      logger.error('Telegram', 'Bot error', err.error);
    });
  }

  return bot;
}

// Express webhook handler with logging
export function getWebhookHandler() {
  const telegramBot = getBot();
  const handler = webhookCallback(telegramBot, 'express', {
    secretToken: config.TELEGRAM_WEBHOOK_SECRET,
  });

  // Wrap with logging middleware
  return async (req: Request, res: Response, _next: NextFunction) => {
    const updateType = req.body?.message ? 'message' :
                       req.body?.callback_query ? 'callback_query' :
                       req.body?.edited_message ? 'edited_message' : 'unknown';
    const userId = req.body?.message?.from?.id ||
                   req.body?.callback_query?.from?.id ||
                   'unknown';

    logger.debug('Webhook', `Received ${updateType} from user ${userId}`);

    try {
      await handler(req, res);
      logger.debug('Webhook', `Processed ${updateType} successfully`);
    } catch (error) {
      logger.error('Webhook', `Failed to process ${updateType}`, error);
      // Still respond 200 to Telegram to prevent retries that could cause webhook removal
      if (!res.headersSent) {
        res.status(200).send('OK');
      }
    }
  };
}

// Check webhook status and repair if needed
export async function checkWebhookHealth(): Promise<boolean> {
  if (!config.TELEGRAM_WEBHOOK_URL || !bot) {
    return false;
  }

  try {
    const webhookInfo = await bot.api.getWebhookInfo();

    if (!webhookInfo.url) {
      logger.warn('Webhook', 'Webhook URL is empty! Attempting to repair...');
      await repairWebhook();
      return false;
    }

    if (webhookInfo.url !== config.TELEGRAM_WEBHOOK_URL) {
      logger.warn('Webhook', `Webhook URL mismatch! Expected: ${config.TELEGRAM_WEBHOOK_URL}, Got: ${webhookInfo.url}`);
      await repairWebhook();
      return false;
    }

    if (webhookInfo.last_error_date) {
      const errorAge = Date.now() / 1000 - webhookInfo.last_error_date;
      const errorAgeMinutes = Math.round(errorAge / 60);
      logger.warn('Webhook', `Last error ${errorAgeMinutes}m ago: ${webhookInfo.last_error_message}`);

      // If error is very recent (within 5 minutes), might indicate ongoing issue
      if (errorAge < 300) {
        logger.warn('Webhook', 'Recent webhook errors detected - monitoring closely');
      }
    }

    if (webhookInfo.pending_update_count > 10) {
      logger.warn('Webhook', `High pending update count: ${webhookInfo.pending_update_count}`);
    }

    logger.debug('Webhook', `Health check OK - pending: ${webhookInfo.pending_update_count}`);
    return true;
  } catch (error) {
    logger.error('Webhook', 'Health check failed', error);
    return false;
  }
}

// Repair webhook by re-setting it
async function repairWebhook(): Promise<void> {
  if (!bot || !config.TELEGRAM_WEBHOOK_URL || !config.TELEGRAM_WEBHOOK_SECRET) {
    logger.error('Webhook', 'Cannot repair webhook - missing configuration');
    return;
  }

  try {
    logger.info('Webhook', 'Repairing webhook...');

    await bot.api.setWebhook(config.TELEGRAM_WEBHOOK_URL, {
      secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    });

    // Verify it was set
    const info = await bot.api.getWebhookInfo();
    if (info.url === config.TELEGRAM_WEBHOOK_URL) {
      logger.info('Webhook', 'Webhook repaired successfully');
    } else {
      logger.error('Webhook', 'Webhook repair failed - URL still incorrect');
    }
  } catch (error) {
    logger.error('Webhook', 'Failed to repair webhook', error);
  }
}

// Start periodic webhook health checks
function startWebhookHealthCheck(): void {
  if (webhookCheckInterval) {
    clearInterval(webhookCheckInterval);
  }

  // Initial check after 1 minute (give server time to stabilize)
  setTimeout(() => {
    checkWebhookHealth();
  }, 60 * 1000);

  // Then check every 5 minutes
  webhookCheckInterval = setInterval(() => {
    checkWebhookHealth();
  }, WEBHOOK_CHECK_INTERVAL_MS);

  logger.info('Webhook', 'Health check scheduled (every 5 minutes)');
}

// Stop webhook health checks
function stopWebhookHealthCheck(): void {
  if (webhookCheckInterval) {
    clearInterval(webhookCheckInterval);
    webhookCheckInterval = null;
  }
}

// Initialize bot (call from index.ts)
export async function initBot(app: Express): Promise<void> {
  if (!config.TELEGRAM_BOT_TOKEN) {
    logger.info('Telegram', 'Bot disabled (no TELEGRAM_BOT_TOKEN)');
    return;
  }

  try {
    const telegramBot = getBot();

    // Test bot connection
    const me = await telegramBot.api.getMe();
    logger.info('Telegram', `Bot connected: @${me.username}`);

    if (config.TELEGRAM_WEBHOOK_URL) {
      // Webhook mode (production) - secret is REQUIRED for security
      if (!config.TELEGRAM_WEBHOOK_SECRET) {
        logger.error('Telegram', 'TELEGRAM_WEBHOOK_SECRET is required when using webhook mode');
        logger.error('Telegram', 'Set TELEGRAM_WEBHOOK_SECRET in your environment variables');
        throw new Error('TELEGRAM_WEBHOOK_SECRET is required for webhook mode');
      }

      app.post('/telegram/webhook', getWebhookHandler());

      // Check current webhook status before setting
      const currentWebhook = await telegramBot.api.getWebhookInfo();
      if (currentWebhook.url) {
        logger.info('Telegram', `Current webhook: ${currentWebhook.url}`);
        if (currentWebhook.last_error_date) {
          const errorAge = Math.round((Date.now() / 1000 - currentWebhook.last_error_date) / 60);
          logger.warn('Telegram', `Previous webhook had error ${errorAge}m ago: ${currentWebhook.last_error_message}`);
        }
      } else {
        logger.warn('Telegram', 'No webhook was configured - this explains missing messages');
      }

      // Set the webhook
      await telegramBot.api.setWebhook(config.TELEGRAM_WEBHOOK_URL, {
        secret_token: config.TELEGRAM_WEBHOOK_SECRET,
      });

      // Verify webhook was set correctly
      const verifyWebhook = await telegramBot.api.getWebhookInfo();
      if (verifyWebhook.url === config.TELEGRAM_WEBHOOK_URL) {
        logger.info('Telegram', `Webhook verified: ${config.TELEGRAM_WEBHOOK_URL}`);
        logger.info('Telegram', `Pending updates: ${verifyWebhook.pending_update_count}`);
      } else {
        logger.error('Telegram', `Webhook verification failed! Expected: ${config.TELEGRAM_WEBHOOK_URL}, Got: ${verifyWebhook.url}`);
      }

      // Start periodic health checks
      startWebhookHealthCheck();
    } else {
      // Polling mode (development)
      telegramBot.start();
      logger.info('Telegram', 'Bot started in polling mode');
    }
  } catch (error) {
    logger.error('Telegram', 'Failed to initialize bot', error);
    // Don't crash the server - continue without Telegram
    logger.warn('Telegram', 'Continuing without Telegram bot');
  }
}

// Stop bot gracefully
export async function stopBot(): Promise<void> {
  stopWebhookHealthCheck();

  if (bot) {
    await bot.stop();
    bot = null;
    logger.info('Telegram', 'Bot stopped');
  }
}
