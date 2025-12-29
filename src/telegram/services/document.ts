import type { Bot } from 'grammy';
import axios from 'axios';
import mammoth from 'mammoth';

import { PDFParse } from 'pdf-parse';

async function parsePdf(buffer: Buffer): Promise<string> {
  const pdfParser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await pdfParser.getText();
  await pdfParser.destroy();
  return result.text;
}
import type { BotContext } from '../bot.js';
import { config } from '../../config.js';
import { getDb } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import type { ConversationData } from '../handlers/conversation.js';

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
  'application/msword', // DOC (older)
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export function setupDocumentHandler(bot: Bot<BotContext>): void {
  // Handle document uploads
  bot.on('message:document', async (ctx) => {
    if (!ctx.telegramUser) return;

    // Only process if we're awaiting a resume
    if (ctx.telegramUser.conversationState !== 'awaiting_resume') {
      await ctx.reply(
        "I wasn't expecting a file right now.\n\n" +
          'Use /subscribe to set up a job search subscription.'
      );
      return;
    }

    const doc = ctx.message.document;
    const mimeType = doc.mime_type;

    // Validate file type
    if (!mimeType || !ALLOWED_MIME_TYPES.includes(mimeType)) {
      await ctx.reply(
        'Please upload a <b>PDF</b> or <b>DOCX</b> file.\n\n' +
          'Or paste your resume as text directly.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Check file size
    if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
      await ctx.reply(
        'File too large. Please upload a file smaller than 10MB.'
      );
      return;
    }

    await ctx.reply('Processing your resume...');

    try {
      // Download file from Telegram
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

      const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      const buffer = Buffer.from(response.data);

      // Parse based on type
      let resumeText: string;

      if (mimeType === 'application/pdf') {
        resumeText = await parsePdf(buffer);
      } else {
        // DOCX
        const result = await mammoth.extractRawText({ buffer });
        resumeText = result.value;
      }

      // Clean up text
      resumeText = resumeText
        .replace(/\s+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      // Validate extracted text
      if (!resumeText || resumeText.length < 100) {
        await ctx.reply(
          'Could not extract enough text from your file.\n\n' +
            'Please paste your resume text directly instead.'
        );
        return;
      }

      // Get current conversation data
      const db = getDb();
      const user = await db.telegramUser.findUnique({
        where: { id: ctx.telegramUser.id },
      });

      const data = (user?.conversationData as ConversationData) || {};

      // Save resume and move to next step
      await db.telegramUser.update({
        where: { id: ctx.telegramUser.id },
        data: {
          conversationState: 'awaiting_min_score',
          conversationData: { ...data, resumeText },
        },
      });

      await ctx.reply(
        `<b>Resume extracted!</b> (${resumeText.length} characters)\n\n` +
          '<b>Step 4/4: Minimum Match Score</b>\n\n' +
          "I'll only notify you about jobs with a score >= this value.\n\n" +
          '<b>Score ranges:</b>\n' +
          '- 90-100: Perfect match\n' +
          '- 70-89: Strong match\n' +
          '- 50-69: Moderate match\n' +
          '- 30-49: Weak match\n\n' +
          'Send a number (1-100) or <b>"Skip"</b> for default (60)',
        { parse_mode: 'HTML' }
      );

      logger.info(
        'Telegram',
        `User ${ctx.telegramUser.telegramId} uploaded resume (${resumeText.length} chars)`
      );
    } catch (error) {
      logger.error('Telegram', 'Resume parsing failed', error);
      await ctx.reply(
        'Failed to parse your file.\n\n' +
          'Please try a different file or paste your resume text directly.'
      );
    }
  });
}
