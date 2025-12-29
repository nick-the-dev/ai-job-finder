import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';

let prisma: PrismaClient | null = null;

export function getDb(): PrismaClient {
  if (!prisma) {
    logger.info('DB', 'Initializing Prisma client...');
    prisma = new PrismaClient({
      log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
    });

    prisma.$on('warn', (e) => logger.warn('DB', e.message));
    prisma.$on('error', (e) => logger.error('DB', e.message));

    logger.info('DB', 'Prisma client initialized');
  }
  return prisma;
}

export async function disconnectDb(): Promise<void> {
  if (prisma) {
    logger.info('DB', 'Disconnecting Prisma client...');
    await prisma.$disconnect();
    prisma = null;
    logger.info('DB', 'Disconnected');
  }
}
