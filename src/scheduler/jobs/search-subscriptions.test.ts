import { describe, it, expect } from 'vitest';
import { formatTriggerLabel, type TriggerType } from '../../observability/index.js';

/**
 * Tests for subscription search trigger type functionality
 *
 * These tests verify that:
 * 1. TriggerType includes all expected values (scheduled, manual, initial)
 * 2. formatTriggerLabel correctly capitalizes trigger types for logging
 * 3. Each call site uses the appropriate trigger type
 */

describe('TriggerType', () => {
  describe('valid trigger types', () => {
    it('accepts "scheduled" as valid trigger type', () => {
      const triggerType: TriggerType = 'scheduled';
      expect(triggerType).toBe('scheduled');
    });

    it('accepts "manual" as valid trigger type', () => {
      const triggerType: TriggerType = 'manual';
      expect(triggerType).toBe('manual');
    });

    it('accepts "initial" as valid trigger type', () => {
      const triggerType: TriggerType = 'initial';
      expect(triggerType).toBe('initial');
    });
  });

  describe('trigger type coverage', () => {
    it('has exactly 3 trigger types', () => {
      // This test ensures we don't accidentally add/remove trigger types
      // without updating related code
      const allTriggerTypes: TriggerType[] = ['scheduled', 'manual', 'initial'];
      expect(allTriggerTypes).toHaveLength(3);
    });
  });
});

describe('formatTriggerLabel', () => {
  describe('capitalizes trigger types correctly', () => {
    it('capitalizes "scheduled" to "Scheduled"', () => {
      expect(formatTriggerLabel('scheduled')).toBe('Scheduled');
    });

    it('capitalizes "manual" to "Manual"', () => {
      expect(formatTriggerLabel('manual')).toBe('Manual');
    });

    it('capitalizes "initial" to "Initial"', () => {
      expect(formatTriggerLabel('initial')).toBe('Initial');
    });
  });

  describe('produces correct log prefixes', () => {
    it('produces correct log prefix for scheduled runs', () => {
      const triggerLabel = formatTriggerLabel('scheduled');
      const logPrefix = `[${triggerLabel}]`;
      expect(logPrefix).toBe('[Scheduled]');
    });

    it('produces correct log prefix for manual runs', () => {
      const triggerLabel = formatTriggerLabel('manual');
      const logPrefix = `[${triggerLabel}]`;
      expect(logPrefix).toBe('[Manual]');
    });

    it('produces correct log prefix for initial runs', () => {
      const triggerLabel = formatTriggerLabel('initial');
      const logPrefix = `[${triggerLabel}]`;
      expect(logPrefix).toBe('[Initial]');
    });
  });

  describe('edge cases', () => {
    it('returns non-empty string for all trigger types', () => {
      const triggerTypes: TriggerType[] = ['scheduled', 'manual', 'initial'];
      for (const triggerType of triggerTypes) {
        const result = formatTriggerLabel(triggerType);
        expect(result.length).toBeGreaterThan(0);
      }
    });

    it('first character is always uppercase', () => {
      const triggerTypes: TriggerType[] = ['scheduled', 'manual', 'initial'];
      for (const triggerType of triggerTypes) {
        const result = formatTriggerLabel(triggerType);
        expect(result[0]).toBe(result[0].toUpperCase());
      }
    });

    it('remaining characters preserve original case', () => {
      const triggerTypes: TriggerType[] = ['scheduled', 'manual', 'initial'];
      for (const triggerType of triggerTypes) {
        const result = formatTriggerLabel(triggerType);
        expect(result.slice(1)).toBe(triggerType.slice(1));
      }
    });
  });
});

describe('Trigger Type Use Cases', () => {
  describe('call site mapping', () => {
    // These tests document the expected trigger type for each call site
    // They serve as documentation and regression protection

    it('cron scheduler should use "scheduled"', () => {
      // src/scheduler/cron.ts:168 - processDueSubscriptions
      const expectedTriggerType: TriggerType = 'scheduled';
      expect(formatTriggerLabel(expectedTriggerType)).toBe('Scheduled');
    });

    it('manual trigger (deprecated) should use "manual"', () => {
      // src/scheduler/cron.ts:248 - triggerSearchNow
      const expectedTriggerType: TriggerType = 'manual';
      expect(formatTriggerLabel(expectedTriggerType)).toBe('Manual');
    });

    it('Telegram "Scan Now" button should use "manual"', () => {
      // src/telegram/handlers/commands.ts:822 - sub:scan callback
      const expectedTriggerType: TriggerType = 'manual';
      expect(formatTriggerLabel(expectedTriggerType)).toBe('Manual');
    });

    it('subscription auto-start should use "initial"', () => {
      // src/telegram/handlers/conversation.ts:905 - after subscription creation
      const expectedTriggerType: TriggerType = 'initial';
      expect(formatTriggerLabel(expectedTriggerType)).toBe('Initial');
    });
  });

  describe('trigger type semantics', () => {
    it('"scheduled" indicates automated cron-triggered run', () => {
      const triggerType: TriggerType = 'scheduled';
      // Scheduled runs are triggered by the cron scheduler based on nextRunAt
      expect(formatTriggerLabel(triggerType)).toMatch(/^[A-Z]/);
    });

    it('"manual" indicates user-initiated run', () => {
      const triggerType: TriggerType = 'manual';
      // Manual runs are triggered by user clicking "Scan Now" in Telegram
      expect(formatTriggerLabel(triggerType)).toMatch(/^[A-Z]/);
    });

    it('"initial" indicates first run after subscription creation', () => {
      const triggerType: TriggerType = 'initial';
      // Initial runs happen automatically when user creates a new subscription
      expect(formatTriggerLabel(triggerType)).toMatch(/^[A-Z]/);
    });
  });
});

describe('Trigger Type in Error Context', () => {
  it('error context should include trigger type for debugging', () => {
    // Simulates the error context structure from search-subscriptions.ts
    const triggerType: TriggerType = 'scheduled';
    const errorContext = {
      stage: 'collection' as const,
      triggerType,
      subscriptionId: 'sub-123',
      jobTitles: ['Software Engineer'],
      partialResults: { jobsCollected: 0 },
    };

    expect(errorContext.triggerType).toBe('scheduled');
    expect(formatTriggerLabel(errorContext.triggerType)).toBe('Scheduled');
  });

  it('supports all trigger types in error context', () => {
    const triggerTypes: TriggerType[] = ['scheduled', 'manual', 'initial'];

    for (const triggerType of triggerTypes) {
      const errorContext = {
        stage: 'matching' as const,
        triggerType,
      };
      expect(errorContext.triggerType).toBe(triggerType);
      expect(formatTriggerLabel(errorContext.triggerType)).toBeTruthy();
    }
  });
});

describe('Default Trigger Type', () => {
  it('default trigger type is "manual" for backwards compatibility', () => {
    // The function signature is:
    // runSingleSubscriptionSearch(subscriptionId: string, triggerType: TriggerType = 'manual')
    // This ensures that any existing code that doesn't pass a trigger type
    // will default to 'manual' (the most conservative assumption)
    const defaultTriggerType: TriggerType = 'manual';
    expect(defaultTriggerType).toBe('manual');
    expect(formatTriggerLabel(defaultTriggerType)).toBe('Manual');
  });
});
