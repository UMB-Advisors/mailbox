'use client';

import { Calendar, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '@/lib/api';
import { calendarExternalUrl } from '@/lib/embed';
import { CenteredNotice, ConnectNotice, reasonNotice } from './panel-chrome';

// MBOX-398 — Calendar day-view panel (Gmail-side-panel style). Reads
// /api/calendar/day (Google Calendar via the google_calendar OAuth grant) and
// renders the day on an hour grid with all-day events banded at the top.

interface DayEvent {
  start: string;
  end: string;
  summary: string;
}
interface DayResult {
  reason: string;
  date: string;
  events: DayEvent[];
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function localToday(): string {
  return new Date().toLocaleDateString('en-CA');
}
function shiftDay(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function isTimed(e: DayEvent): boolean {
  return e.start.includes('T');
}
function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtDateLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? dateStr
    : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function hourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

export function CalendarPanel() {
  const [date, setDate] = useState(localToday);
  const [result, setResult] = useState<DayResult | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (d: string) => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/calendar/day?date=${d}`));
      const data = (await res.json().catch(() => null)) as DayResult | null;
      setResult(data ?? { reason: 'fetch_failed', date: d, events: [] });
    } catch {
      setResult({ reason: 'fetch_failed', date: d, events: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
        <button
          type="button"
          onClick={() => setDate(localToday())}
          className="rounded-sm border border-border px-2 py-0.5 font-mono text-[11px] text-ink-muted hover:text-ink"
        >
          Today
        </button>
        <button
          type="button"
          aria-label="Previous day"
          onClick={() => setDate((d) => shiftDay(d, -1))}
          className="rounded-sm p-1 text-ink-dim hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Next day"
          onClick={() => setDate((d) => shiftDay(d, 1))}
          className="rounded-sm p-1 text-ink-dim hover:text-ink"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
        <span className="ml-1 font-mono text-[12px] text-ink">{fmtDateLabel(date)}</span>
        <a
          href={calendarExternalUrl()}
          target="_blank"
          rel="noopener noreferrer"
          title="Open Google Calendar"
          className="ml-auto rounded-sm p-1 text-ink-dim hover:text-ink"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      </div>

      {loading && !result ? (
        <CenteredNotice title="Loading…" />
      ) : !result || result.reason === 'not_connected' ? (
        <ConnectNotice
          icon={<Calendar className="h-8 w-8 text-ink-dim" aria-hidden />}
          label="Calendar"
        />
      ) : result.reason !== 'ok' ? (
        reasonNotice(result.reason)
      ) : (
        <DayGrid events={result.events} />
      )}
    </div>
  );
}

function DayGrid({ events }: { events: DayEvent[] }) {
  const allDay = events.filter((e) => !isTimed(e));
  const timed = events.filter(isTimed);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {allDay.length > 0 && (
        <div className="space-y-1 border-b border-border-subtle p-2">
          {allDay.map((e) => (
            <div
              key={`${e.start}-${e.summary}`}
              className="truncate rounded-sm bg-accent-orange/80 px-2 py-1 text-xs font-medium text-bg-deep"
            >
              {e.summary || '(busy)'}
            </div>
          ))}
        </div>
      )}
      <ul>
        {HOURS.map((h) => {
          const inHour = timed.filter((e) => new Date(e.start).getHours() === h);
          return (
            <li
              key={h}
              className="flex min-h-[2.5rem] gap-2 border-b border-border-subtle/50 px-2 py-1"
            >
              <span className="w-12 shrink-0 pt-0.5 text-right font-mono text-[10px] text-ink-dim">
                {hourLabel(h)}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                {inHour.map((e) => (
                  <div
                    key={`${e.start}-${e.summary}`}
                    className="rounded-sm border-l-2 border-accent-green bg-accent-green/15 px-2 py-1"
                  >
                    <div className="truncate text-xs font-medium text-ink">
                      {e.summary || '(busy)'}
                    </div>
                    <div className="font-mono text-[10px] text-ink-dim">
                      {fmtTime(e.start)}
                      {e.end ? `–${fmtTime(e.end)}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
