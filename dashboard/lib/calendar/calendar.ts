// dashboard/lib/calendar/calendar.ts
//
// MBOX-130 — read-only Google Calendar pre-read at draft time.
//
// When an inbound classifies as `scheduling` (and CALENDAR_CONTEXT_ENABLED=1),
// the draft route fetches the operator's calendar (now → now+14d) and renders a
// compact `calendar_snapshot` block that gets injected into the draft prompt
// alongside rag_refs (lib/drafting/prompt.ts). The drafter can then propose
// concrete time slots instead of "let me check my calendar and get back to you."
//
// Privacy gate (mirrors RAG cloud-route, STAQPRO-191):
//   - LOCAL route  (Qwen3 on-device) — snapshot ALWAYS passes through.
//   - CLOUD route  — snapshot ONLY passes if CALENDAR_CLOUD_ROUTE_ENABLED=1.
//     Default off → cloud drafts fall back to the no-calendar boilerplate.
//
// Augmentation, not a gate (RAG convention): ANY non-ok reason returns an empty
// snapshot + a reason string. The caller never blocks the draft on a failed
// calendar read — it sets drafts.scheduling_calendar_unavailable and falls back.
//
// No googleapis SDK — direct fetch against the Calendar v3 events endpoint with
// the access token from lib/oauth/google.ts.

import type { DraftSource } from '@/lib/drafting/router';
import { getAccessToken, getConnection, markFetched, OAuthTokenError } from '@/lib/oauth/google';

// Why a calendar read returned no usable snapshot. 'ok' means events were
// fetched (the snapshot may still be empty if the window is genuinely free —
// see `reason: 'no_events'`). Distinct values so the audit surface can tell a
// privacy gate from a token failure from an empty calendar.
export type CalendarReason =
  | 'ok'
  | 'disabled' // CALENDAR_CONTEXT_ENABLED != 1
  | 'cloud_gated' // cloud route + CALENDAR_CLOUD_ROUTE_ENABLED != 1
  | 'not_connected' // no google_calendar oauth token
  | 'token_expired' // refresh token revoked/expired — operator must reconnect
  | 'rate_limited' // Google Calendar API 429
  | 'fetch_failed' // network / 5xx / parse
  | 'no_events'; // fetched cleanly, window is free

export interface CalendarEvent {
  start: string; // ISO
  end: string; // ISO
  summary: string;
}

export interface CalendarSnapshot {
  reason: CalendarReason;
  // Compact rendered lines, e.g. "Mon May 19 14:00-15:00 — STATE 1:1". Empty
  // for any non-ok reason OR a genuinely free window.
  lines: ReadonlyArray<string>;
}

export interface CalendarFetchInput {
  draft_source: DraftSource;
  // Window size in days; defaults to 14 (CALENDAR_LOOKAHEAD_DAYS override).
  lookaheadDays?: number;
  // Injectable clock for tests.
  now?: Date;
}

const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export function isCalendarContextEnabled(): boolean {
  return process.env.CALENDAR_CONTEXT_ENABLED === '1';
}

export function isCalendarCloudRouteEnabled(): boolean {
  return process.env.CALENDAR_CLOUD_ROUTE_ENABLED === '1';
}

function lookaheadDays(input: CalendarFetchInput): number {
  const fromInput = input.lookaheadDays;
  if (typeof fromInput === 'number' && fromInput > 0) return fromInput;
  const fromEnv = Number(process.env.CALENDAR_LOOKAHEAD_DAYS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 14;
}

// ── Per-draft fetch cache (TTL ~30s) ─────────────────────────────────────────
// MBOX-130 — repeated draft assembly within a short window must not hammer the
// Calendar API. Keyed by draft_source so a local and cloud assembly of the same
// inbound don't cross the privacy gate via a shared cache entry.

const CACHE_TTL_MS = Number(process.env.CALENDAR_CACHE_TTL_MS) || 30_000;
interface CacheEntry {
  at: number;
  snapshot: CalendarSnapshot;
}
const cache = new Map<string, CacheEntry>();

export function clearCalendarCache(): void {
  cache.clear();
}

// Compact one-line render: "Mon May 19 14:00-15:00 — <summary>".
// Render in the operator's timezone (GENERIC_TIMEZONE) rather than the Node
// process tz — the mailbox-dashboard container sets no TZ so it defaults to UTC,
// which would show wrong availability and make the LLM propose booked slots.
export function formatEventLine(ev: CalendarEvent): string {
  const start = new Date(ev.start);
  const end = new Date(ev.end);
  if (Number.isNaN(start.getTime())) return '';
  const tz = process.env.GENERIC_TIMEZONE ?? 'UTC';
  const day = start.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  });
  const fmtTime = (d: Date) =>
    Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: tz,
        });
  const range = Number.isNaN(end.getTime()) ? fmtTime(start) : `${fmtTime(start)}-${fmtTime(end)}`;
  const summary = (ev.summary || '(busy)').slice(0, 80);
  return `${day} ${range} — ${summary}`;
}

// Map a raw Google Calendar v3 event into our compact shape, filtered to events
// the operator actually attends. All-day events (date, not dateTime) are kept —
// they still block availability. Cancelled events are dropped.
function coerceEvents(rawItems: unknown, operatorEmail: string | null): CalendarEvent[] {
  if (!Array.isArray(rawItems)) return [];
  const out: CalendarEvent[] = [];
  for (const raw of rawItems) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (o.status === 'cancelled') continue;

    const start = readWhen(o.start);
    const end = readWhen(o.end);
    if (!start) continue;

    // Attendee/organizer filter: keep when the operator is the organizer OR an
    // attendee. When operatorEmail is unknown (account_email not yet resolved),
    // keep everything on the primary calendar — it's the operator's own calendar
    // so the events are theirs by definition.
    if (operatorEmail && !operatorIsInvolved(o, operatorEmail)) continue;

    out.push({
      start,
      end: end ?? start,
      summary: typeof o.summary === 'string' ? o.summary : '(busy)',
    });
  }
  return out;
}

function readWhen(when: unknown): string | null {
  if (typeof when !== 'object' || when === null) return null;
  const w = when as Record<string, unknown>;
  if (typeof w.dateTime === 'string') return w.dateTime;
  if (typeof w.date === 'string') return w.date; // all-day
  return null;
}

function operatorIsInvolved(o: Record<string, unknown>, operatorEmail: string): boolean {
  const lower = operatorEmail.toLowerCase();
  const organizer = o.organizer as Record<string, unknown> | undefined;
  if (typeof organizer?.email === 'string' && organizer.email.toLowerCase() === lower) {
    return true;
  }
  const attendees = o.attendees;
  if (Array.isArray(attendees)) {
    for (const a of attendees) {
      if (
        typeof a === 'object' &&
        a !== null &&
        typeof (a as Record<string, unknown>).email === 'string' &&
        ((a as Record<string, unknown>).email as string).toLowerCase() === lower
      ) {
        return true;
      }
    }
  }
  return false;
}

// Fetch the calendar snapshot for a draft. Never throws — every failure maps to
// a typed reason + empty lines so the draft path can fall back gracefully.
export async function getCalendarSnapshot(input: CalendarFetchInput): Promise<CalendarSnapshot> {
  if (!isCalendarContextEnabled()) {
    return { reason: 'disabled', lines: [] };
  }
  // Privacy gate — cloud route is opt-in.
  if (input.draft_source === 'cloud' && !isCalendarCloudRouteEnabled()) {
    return { reason: 'cloud_gated', lines: [] };
  }

  const cacheKey = input.draft_source;
  const cached = cache.get(cacheKey);
  const nowMs = Date.now();
  if (cached && nowMs - cached.at < CACHE_TTL_MS) {
    return cached.snapshot;
  }

  const snapshot = await fetchSnapshot(input);
  // Only cache terminal outcomes that are cheap-correct to reuse for ~30s.
  // 'rate_limited' and 'fetch_failed' are cached too — re-hammering a failing
  // API inside the TTL window is exactly what the cache exists to prevent.
  cache.set(cacheKey, { at: nowMs, snapshot });
  return snapshot;
}

async function fetchSnapshot(input: CalendarFetchInput): Promise<CalendarSnapshot> {
  const conn = await getConnection('google_calendar');
  if (!conn.connected) {
    return { reason: 'not_connected', lines: [] };
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken('google_calendar');
  } catch (err) {
    if (err instanceof OAuthTokenError) {
      if (err.kind === 'not_connected') return { reason: 'not_connected', lines: [] };
      if (err.kind === 'auth') return { reason: 'token_expired', lines: [] };
      return { reason: 'fetch_failed', lines: [] };
    }
    return { reason: 'fetch_failed', lines: [] };
  }

  const now = input.now ?? new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(
    now.getTime() + lookaheadDays(input) * 24 * 60 * 60 * 1000,
  ).toISOString();
  const url = new URL(CALENDAR_EVENTS_URL);
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '50');

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { reason: 'fetch_failed', lines: [] };
  }

  if (res.status === 429) {
    return { reason: 'rate_limited', lines: [] };
  }
  if (res.status === 401 || res.status === 403) {
    return { reason: 'token_expired', lines: [] };
  }
  if (!res.ok) {
    return { reason: 'fetch_failed', lines: [] };
  }

  const json = (await res.json().catch(() => null)) as { items?: unknown } | null;
  if (!json) {
    return { reason: 'fetch_failed', lines: [] };
  }

  const events = coerceEvents(json.items, conn.account_email);
  // Best-effort stamp; a stamp failure must not fail the fetch.
  void markFetched('google_calendar').catch(() => undefined);

  if (events.length === 0) {
    return { reason: 'no_events', lines: [] };
  }

  const lines = events.map((ev) => formatEventLine(ev)).filter((l) => l.length > 0);
  return { reason: 'ok', lines };
}
