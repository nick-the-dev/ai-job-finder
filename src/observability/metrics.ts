/**
 * Sentry Business Metrics
 *
 * Custom metrics for tracking business KPIs in Sentry Insights.
 * These metrics provide visibility into application health and performance.
 *
 * Note: Sentry v10 uses 'attributes' (not 'tags') for metric metadata.
 */

import * as Sentry from '@sentry/node';

/**
 * Track jobs collected from a source
 */
export function trackJobsCollected(count: number, source: 'jobspy' | 'serpapi' | 'google_jobs'): void {
  Sentry.metrics.count('jobs.collected', count, {
    attributes: { source },
  });
}

/**
 * Track jobs matched against resume
 */
export function trackJobsMatched(count: number, subscriptionId?: string): void {
  Sentry.metrics.count('jobs.matched', count, {
    attributes: subscriptionId ? { subscription_id: subscriptionId } : undefined,
  });
}

/**
 * Track jobs filtered out by score threshold
 */
export function trackJobsFiltered(count: number): void {
  Sentry.metrics.count('jobs.filtered', count);
}

/**
 * Track notifications sent to users
 */
export function trackNotificationSent(channel: 'telegram' | 'email' = 'telegram'): void {
  Sentry.metrics.count('notifications.sent', 1, {
    attributes: { channel },
  });
}

/**
 * Track subscription run completion
 */
export function trackSubscriptionRunCompleted(
  success: boolean,
  triggerType: 'scheduled' | 'manual' | 'api'
): void {
  Sentry.metrics.count('subscription.run.completed', 1, {
    attributes: {
      success: success ? 'true' : 'false',
      trigger_type: triggerType,
    },
  });
}

/**
 * Track subscription run duration
 */
export function trackSubscriptionRunDuration(durationMs: number, triggerType: string): void {
  Sentry.metrics.distribution('subscription.run.duration', durationMs, {
    attributes: { trigger_type: triggerType },
    unit: 'millisecond',
  });
}

/**
 * Track queue job wait time (time from enqueue to processing start)
 */
export function trackQueueWaitTime(queueName: 'collection' | 'matching', waitTimeMs: number): void {
  Sentry.metrics.distribution('queue.wait_time', waitTimeMs, {
    attributes: { queue: queueName },
    unit: 'millisecond',
  });
}

/**
 * Track LLM call latency
 */
export function trackLLMLatency(operation: string, latencyMs: number): void {
  Sentry.metrics.distribution('llm.latency', latencyMs, {
    attributes: { operation },
    unit: 'millisecond',
  });
}

/**
 * Track LLM token usage
 */
export function trackLLMTokens(operation: string, tokens: number): void {
  Sentry.metrics.count('llm.tokens', tokens, {
    attributes: { operation },
  });
}

/**
 * Track active subscriptions (gauge - current count)
 */
export function trackActiveSubscriptions(count: number): void {
  Sentry.metrics.gauge('subscriptions.active', count);
}

/**
 * Track total users (gauge - current count)
 */
export function trackTotalUsers(count: number): void {
  Sentry.metrics.gauge('users.total', count);
}

/**
 * Track cache hits/misses for job matching
 */
export function trackMatchCacheHit(hit: boolean): void {
  Sentry.metrics.count('match.cache', 1, {
    attributes: { result: hit ? 'hit' : 'miss' },
  });
}

/**
 * Track external API errors
 */
export function trackApiError(api: 'jobspy' | 'serpapi' | 'openrouter' | 'google_jobs', errorType: string): void {
  Sentry.metrics.count('api.errors', 1, {
    attributes: { api, error_type: errorType },
  });
}

/**
 * Track job match scores distribution
 */
export function trackMatchScore(score: number): void {
  Sentry.metrics.distribution('match.score', score, {
    unit: 'none',
  });
}
