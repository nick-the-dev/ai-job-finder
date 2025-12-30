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

/**
 * Subscription-scoped logger that enables debug logging when debugMode is true.
 * When debugMode is enabled, debug logs are shown regardless of global LOG_LEVEL.
 * All logs include the subscription ID for easy filtering.
 */
export class SubscriptionLogger {
  private subscriptionId: string;
  private debugMode: boolean;
  private shortId: string;

  constructor(subscriptionId: string, debugMode: boolean) {
    this.subscriptionId = subscriptionId;
    this.debugMode = debugMode;
    this.shortId = subscriptionId.slice(0, 8);
  }

  private formatContext(context: string): string {
    return `${context}:${this.shortId}`;
  }

  /**
   * Debug logs are shown when:
   * 1. Global LOG_LEVEL is 'debug', OR
   * 2. This subscription has debugMode enabled
   */
  debug(context: string, message: string, data?: unknown): void {
    const formattedContext = this.formatContext(context);
    if (this.debugMode) {
      // Force debug output by calling log directly, bypassing level check
      const color = colors.debug;
      const prefix = `${colors.reset}[${formatTime()}] ${color}DEBUG${colors.reset}`;
      const ctx = `[${formattedContext}]`;
      const debugTag = `${colors.warn}[DEBUG MODE]${colors.reset}`;

      if (data !== undefined) {
        let formattedData: string;
        if (data instanceof Error) {
          formattedData = `${data.name}: ${data.message}${data.stack ? `\n${data.stack}` : ''}`;
        } else if (typeof data === 'object') {
          formattedData = JSON.stringify(data, null, 2);
        } else {
          formattedData = String(data);
        }
        console.log(`${prefix} ${debugTag} ${ctx} ${message}`, formattedData);
      } else {
        console.log(`${prefix} ${debugTag} ${ctx} ${message}`);
      }
    } else {
      // Use normal log path (respects LOG_LEVEL)
      log('debug', formattedContext, message, data);
    }
  }

  info(context: string, message: string, data?: unknown): void {
    log('info', this.formatContext(context), message, data);
  }

  warn(context: string, message: string, data?: unknown): void {
    log('warn', this.formatContext(context), message, data);
  }

  error(context: string, message: string, data?: unknown): void {
    log('error', this.formatContext(context), message, data);
  }

  /**
   * Get the subscription ID for reference
   */
  getSubscriptionId(): string {
    return this.subscriptionId;
  }

  /**
   * Check if debug mode is enabled
   */
  isDebugMode(): boolean {
    return this.debugMode;
  }
}

/**
 * Create a subscription-scoped logger
 */
export function createSubscriptionLogger(subscriptionId: string, debugMode: boolean): SubscriptionLogger {
  return new SubscriptionLogger(subscriptionId, debugMode);
}

export default logger;
