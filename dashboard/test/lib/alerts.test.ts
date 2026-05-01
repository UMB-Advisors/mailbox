import { describe, expect, it } from 'vitest';
import {
  COST_SPIKE_MIN_TRIGGER_USD,
  DRAFT_BACKLOG_THRESHOLD_HOURS,
  evaluateAlerts,
  evaluateCloudCostSpike,
  evaluateDraftBacklog,
  evaluateN8nFailures,
} from '@/lib/alerts';

describe('evaluateDraftBacklog', () => {
  it('returns null when aged_count is 0', () => {
    expect(evaluateDraftBacklog({ aged_count: 0, threshold_hours: 4 })).toBeNull();
  });

  it('emits warn at any positive aged_count below alarm', () => {
    const a = evaluateDraftBacklog({ aged_count: 1, threshold_hours: 4 });
    expect(a?.severity).toBe('warn');
    expect(a?.code).toBe('DRAFT_BACKLOG_AGED');
    expect(a?.value).toBe(1);
  });

  it('emits alarm above 5', () => {
    const a = evaluateDraftBacklog({ aged_count: 8, threshold_hours: 4 });
    expect(a?.severity).toBe('alarm');
    expect(a?.value).toBe(8);
  });

  it('warn boundary: aged_count = 5 stays at warn (not yet alarm)', () => {
    const a = evaluateDraftBacklog({ aged_count: 5, threshold_hours: 4 });
    expect(a?.severity).toBe('warn');
  });
});

describe('evaluateN8nFailures', () => {
  it('returns null when total is 0 (no executions, nothing to rate)', () => {
    expect(evaluateN8nFailures({ failed_count: 0, total_count: 0 })).toBeNull();
  });

  it('returns null at 5% (boundary stays clean)', () => {
    expect(evaluateN8nFailures({ failed_count: 5, total_count: 100 })).toBeNull();
  });

  it('emits warn just above 5%', () => {
    const a = evaluateN8nFailures({ failed_count: 6, total_count: 100 });
    expect(a?.severity).toBe('warn');
  });

  it('emits alarm just above 20%', () => {
    const a = evaluateN8nFailures({ failed_count: 21, total_count: 100 });
    expect(a?.severity).toBe('alarm');
  });

  it('handles single-execution-all-failed (rate=1.0)', () => {
    const a = evaluateN8nFailures({ failed_count: 1, total_count: 1 });
    expect(a?.severity).toBe('alarm');
    expect(a?.value).toBe(1);
  });
});

describe('evaluateCloudCostSpike', () => {
  it('returns null when last_hour < min_trigger (cheap noise floor)', () => {
    expect(
      evaluateCloudCostSpike({
        last_hour_usd: 0.1,
        trailing_24h_usd: 0.001,
        min_trigger_usd: COST_SPIKE_MIN_TRIGGER_USD,
      }),
    ).toBeNull();
  });

  it('returns null when trailing_24h is 0 (no baseline to spike against)', () => {
    expect(
      evaluateCloudCostSpike({
        last_hour_usd: 1.0,
        trailing_24h_usd: 0,
        min_trigger_usd: COST_SPIKE_MIN_TRIGGER_USD,
      }),
    ).toBeNull();
  });

  it('emits warn at 4x trailing average above min_trigger', () => {
    // hourlyAvg = 24 / 24 = 1.0; last_hour = 4.0 → 4x
    const a = evaluateCloudCostSpike({
      last_hour_usd: 4.0,
      trailing_24h_usd: 24,
      min_trigger_usd: COST_SPIKE_MIN_TRIGGER_USD,
    });
    expect(a?.severity).toBe('warn');
    expect(a?.value).toBeCloseTo(4, 1);
  });

  it('emits alarm at 11x', () => {
    // hourlyAvg = 24 / 24 = 1.0; last_hour = 11.0 → 11x
    const a = evaluateCloudCostSpike({
      last_hour_usd: 11.0,
      trailing_24h_usd: 24,
      min_trigger_usd: COST_SPIKE_MIN_TRIGGER_USD,
    });
    expect(a?.severity).toBe('alarm');
  });
});

describe('evaluateAlerts', () => {
  it('returns empty array when all inputs are null', () => {
    expect(
      evaluateAlerts({
        draftBacklog: null,
        n8nFailures: null,
        cloudCostSpike: null,
      }),
    ).toEqual([]);
  });

  it('omits non-firing alerts but includes firing ones', () => {
    const result = evaluateAlerts({
      draftBacklog: { aged_count: 8, threshold_hours: 4 },
      n8nFailures: { failed_count: 1, total_count: 1000 },
      cloudCostSpike: null,
    });
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe('DRAFT_BACKLOG_AGED');
    expect(result[0].severity).toBe('alarm');
  });

  it('preserves the threshold-hours metadata constant', () => {
    expect(DRAFT_BACKLOG_THRESHOLD_HOURS).toBe(4);
  });
});
