/**
 * Simple logger with clear, short output for monitoring and debugging
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const colors = {
  debug: '\x1b[90m',  // gray
  info: '\x1b[36m',   // cyan
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
  reset: '\x1b[0m',
};

function formatTime(): string {
  return new Date().toISOString().substring(11, 23);
}

function log(level: LogLevel, context: string, message: string, data?: unknown): void {
  const color = colors[level];
  const prefix = `${colors.reset}[${formatTime()}] ${color}${level.toUpperCase().padEnd(5)}${colors.reset}`;
  const ctx = `[${context}]`;

  if (data !== undefined) {
    console.log(`${prefix} ${ctx} ${message}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
  } else {
    console.log(`${prefix} ${ctx} ${message}`);
  }
}

export const logger = {
  debug: (context: string, message: string, data?: unknown) => log('debug', context, message, data),
  info: (context: string, message: string, data?: unknown) => log('info', context, message, data),
  warn: (context: string, message: string, data?: unknown) => log('warn', context, message, data),
  error: (context: string, message: string, data?: unknown) => log('error', context, message, data),
};

export default logger;
