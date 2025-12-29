import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';

let prisma: PrismaClient | null = null;

export function getDb(): PrismaClient {
  if (!prisma) {
    logger.info('DB', 'Initializing Prisma client...');
    prisma = new PrismaClient();
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
