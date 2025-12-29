/**
 * Simple logger with clear, short output for monitoring and debugging
 * Supports LOG_LEVEL env var: debug | info | warn | error (default: info)
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const colors = {
  debug: '\x1b[90m',  // gray
  info: '\x1b[36m',   // cyan
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
  reset: '\x1b[0m',
};

const levelPriority: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getLogLevel(): LogLevel {
  const level = process.env.LOG_LEVEL?.toLowerCase();
  if (level && level in levelPriority) {
    return level as LogLevel;
  }
  return 'info'; // default
}

function formatTime(): string {
  return new Date().toISOString().substring(11, 23);
}

function log(level: LogLevel, context: string, message: string, data?: unknown): void {
  // Filter by log level
  const minLevel = getLogLevel();
  if (levelPriority[level] < levelPriority[minLevel]) {
    return;
  }

  const color = colors[level];
  const prefix = `${colors.reset}[${formatTime()}] ${color}${level.toUpperCase().padEnd(5)}${colors.reset}`;
  const ctx = `[${context}]`;

  if (data !== undefined) {
    // Handle Error objects specially (they don't serialize with JSON.stringify)
    let formattedData: string;
    if (data instanceof Error) {
      formattedData = `${data.name}: ${data.message}${data.stack ? `\n${data.stack}` : ''}`;
    } else if (typeof data === 'object') {
      formattedData = JSON.stringify(data, null, 2);
    } else {
      formattedData = String(data);
    }
    console.log(`${prefix} ${ctx} ${message}`, formattedData);
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
