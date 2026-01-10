import * as Sentry from '@sentry/node';

/**
 * Set Sentry user context for error attribution
 */
export function setSentryUser(userId: string, username?: string | null): void {
  Sentry.setUser({
    id: userId,
    username: username || undefined,
  });
}

/**
 * Clear Sentry user context (e.g., on logout or between runs)
 */
export function clearSentryUser(): void {
  Sentry.setUser(null);
}

/**
 * Add a breadcrumb for tracking operation flow
 * Breadcrumbs create a trail of events leading up to errors
 */
export function addBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>,
  level: Sentry.SeverityLevel = 'info'
): void {
  Sentry.addBreadcrumb({
    category,
    message,
    data,
    level,
    timestamp: Date.now() / 1000,
  });
}

/**
 * Execute a function within a scoped Sentry context
 * Tags and context added within the scope don't affect other operations
 */
export async function withSentryScope<T>(
  tags: Record<string, string>,
  callback: () => Promise<T>
): Promise<T> {
  return Sentry.withScope(async (scope) => {
    for (const [key, value] of Object.entries(tags)) {
      scope.setTag(key, value);
    }
    return callback();
  });
}

/**
 * Set subscription context for the current scope
 * Used when processing subscription runs
 */
export function setSubscriptionContext(
  subscriptionId: string,
  userId: string,
  username?: string | null,
  triggerType?: string
): void {
  Sentry.setUser({
    id: userId,
    username: username || undefined,
  });

  Sentry.setTags({
    subscriptionId: subscriptionId.slice(0, 8), // Short ID for grouping
    triggerType: triggerType || 'unknown',
  });
}

/**
 * Add a breadcrumb for subscription run stages
 */
export function addRunStageBreadcrumb(
  stage: 'collection' | 'normalization' | 'matching' | 'notification' | 'completed',
  detail?: string,
  data?: Record<string, unknown>
): void {
  addBreadcrumb('subscription-run', `Stage: ${stage}${detail ? ` - ${detail}` : ''}`, data);
}

/**
 * Add a breadcrumb for external API calls
 */
export function addApiCallBreadcrumb(
  service: string,
  operation: string,
  data?: Record<string, unknown>
): void {
  addBreadcrumb('http', `${service}: ${operation}`, data);
}

/**
 * Add a breadcrumb for LLM operations
 */
export function addLLMBreadcrumb(
  operation: string,
  data?: Record<string, unknown>
): void {
  addBreadcrumb('llm', operation, data);
}

/**
 * Add a breadcrumb for queue operations
 */
export function addQueueBreadcrumb(
  queue: string,
  action: 'enqueue' | 'process' | 'complete' | 'fail',
  data?: Record<string, unknown>
): void {
  addBreadcrumb('queue', `${queue}: ${action}`, data);
}

/**
 * Set context for Telegram bot operations
 */
export function setTelegramUserContext(
  telegramId: number,
  username?: string,
  chatId?: number
): void {
  Sentry.setUser({
    id: telegramId.toString(),
    username: username || undefined,
  });

  if (chatId) {
    Sentry.setTag('chatId', chatId.toString());
  }
}
