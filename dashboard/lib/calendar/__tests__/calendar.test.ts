// dashboard/lib/calendar/__tests__/calendar.test.ts
//
// MBOX-130 — unit tests for the calendar pre-read. Covers the pure
// formatter, the feature/privacy gates (env-driven), and the no-op short
// circuits. The actual Google fetch is not exercised here (no network); the
// gate + format logic is the part with the privacy contract worth pinning.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearCalendarCache,
  formatEventLine,
  getCalendarSnapshot,
  isCalendarCloudRouteEnabled,
  isCalendarContextEnabled,
} from '../calendar';

const ENV_KEYS = ['CALENDAR_CONTEXT_ENABLED', 'CALENDAR_CLOUD_ROUTE_ENABLED'] as const;

describe('formatEventLine', () => {
  it('renders a compact "Day HH:MM-HH:MM — summary" line', () => {
    const line = formatEventLine({
      start: '2026-05-19T14:00:00.000Z',
      end: '2026-05-19T15:00:00.000Z',
      summary: 'STATE 1:1',
    });
    // Time portion is locale/tz-dependent in CI, so assert structure not exact
    // clock — the dash separator + summary are the load-bearing parts.
    expect(line).toContain('— STATE 1:1');
    expect(line).toMatch(/\d{2}:\d{2}-\d{2}:\d{2}/);
  });

  it('falls back to (busy) when summary is empty', () => {
    const line = formatEventLine({
      start: '2026-05-19T14:00:00.000Z',
      end: '2026-05-19T15:00:00.000Z',
      summary: '',
    });
    expect(line).toContain('— (busy)');
  });

  it('returns empty string for an unparseable start', () => {
    const line = formatEventLine({ start: 'not-a-date', end: 'x', summary: 'X' });
    expect(line).toBe('');
  });

  it('truncates a very long summary to 80 chars', () => {
    const long = 'x'.repeat(200);
    const line = formatEventLine({
      start: '2026-05-19T14:00:00.000Z',
      end: '2026-05-19T15:00:00.000Z',
      summary: long,
    });
    const summaryPart = line.split('— ')[1] ?? '';
    expect(summaryPart.length).toBe(80);
  });
});

describe('calendar gates', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    clearCalendarCache();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    clearCalendarCache();
  });

  it('isCalendarContextEnabled tracks the env flag', () => {
    process.env.CALENDAR_CONTEXT_ENABLED = '1';
    expect(isCalendarContextEnabled()).toBe(true);
    process.env.CALENDAR_CONTEXT_ENABLED = '0';
    expect(isCalendarContextEnabled()).toBe(false);
    delete process.env.CALENDAR_CONTEXT_ENABLED;
    expect(isCalendarContextEnabled()).toBe(false);
  });

  it('isCalendarCloudRouteEnabled defaults off', () => {
    delete process.env.CALENDAR_CLOUD_ROUTE_ENABLED;
    expect(isCalendarCloudRouteEnabled()).toBe(false);
    process.env.CALENDAR_CLOUD_ROUTE_ENABLED = '1';
    expect(isCalendarCloudRouteEnabled()).toBe(true);
  });

  it('returns reason=disabled (no DB / no fetch) when the feature flag is off', async () => {
    delete process.env.CALENDAR_CONTEXT_ENABLED;
    const snap = await getCalendarSnapshot({ draft_source: 'local' });
    expect(snap.reason).toBe('disabled');
    expect(snap.lines).toEqual([]);
  });

  it('CLOUD route is gated when CALENDAR_CLOUD_ROUTE_ENABLED is off — no calendar data leaves', async () => {
    process.env.CALENDAR_CONTEXT_ENABLED = '1';
    delete process.env.CALENDAR_CLOUD_ROUTE_ENABLED;
    const snap = await getCalendarSnapshot({ draft_source: 'cloud' });
    // The gate returns BEFORE any getConnection / token / fetch — no DB needed.
    expect(snap.reason).toBe('cloud_gated');
    expect(snap.lines).toEqual([]);
  });
});
