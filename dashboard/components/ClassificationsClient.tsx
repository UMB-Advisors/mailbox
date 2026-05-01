'use client';

import { useMemo, useState } from 'react';
import { CATEGORIES, type Category } from '@/lib/classification/prompt';
import type {
  ClassificationRoute,
  ClassificationRow,
  DraftOutcome,
} from '@/lib/queries-classifications';
import { AppNav } from './AppNav';
import { TimeAgo } from './TimeAgo';

const ROUTES: ClassificationRoute[] = ['drop', 'local', 'cloud'];

export function ClassificationsClient({ initialRows }: { initialRows: ClassificationRow[] }) {
  const [categoryFilter, setCategoryFilter] = useState<Category | null>(null);
  const [routeFilter, setRouteFilter] = useState<ClassificationRoute | null>(null);
  const [confidenceFilter, setConfidenceFilter] = useState<'low' | 'mid' | 'high' | null>(null);

  const filtered = useMemo(() => {
    return initialRows.filter((r) => {
      if (categoryFilter && r.category !== categoryFilter) return false;
      if (routeFilter && r.route !== routeFilter) return false;
      if (confidenceFilter === 'low' && r.confidence >= 0.6) return false;
      if (confidenceFilter === 'mid' && (r.confidence < 0.6 || r.confidence >= 0.85)) return false;
      if (confidenceFilter === 'high' && r.confidence < 0.85) return false;
      return true;
    });
  }, [initialRows, categoryFilter, routeFilter, confidenceFilter]);

  const categoryCounts = useMemo(() => {
    const acc = new Map<string, number>();
    for (const r of initialRows) acc.set(r.category, (acc.get(r.category) ?? 0) + 1);
    return acc;
  }, [initialRows]);

  const routeCounts = useMemo(() => {
    const acc = new Map<ClassificationRoute, number>();
    for (const r of initialRows) acc.set(r.route, (acc.get(r.route) ?? 0) + 1);
    return acc;
  }, [initialRows]);

  const hasFilter = categoryFilter || routeFilter || confidenceFilter;

  return (
    <main className="flex h-screen flex-col bg-bg-deep text-ink">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-panel px-4">
        <div className="flex items-center gap-3">
          <h1 className="font-sans text-sm font-semibold tracking-tight">MailBox One</h1>
          <AppNav active="classifications" />
          <span className="rounded-full border border-border bg-bg-deep px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-muted">
            {filtered.length}
            {filtered.length !== initialRows.length ? ` / ${initialRows.length}` : ''}
          </span>
        </div>
      </header>

      {/* Filter bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-subtle bg-bg-surface px-3 py-2 text-[11px]">
        <span className="font-mono uppercase tracking-wide text-ink-dim">category:</span>
        {CATEGORIES.map((cat) => {
          const count = categoryCounts.get(cat) ?? 0;
          if (count === 0) return null;
          return (
            <Pill
              key={cat}
              label={cat}
              count={count}
              active={categoryFilter === cat}
              onClick={() => setCategoryFilter((c) => (c === cat ? null : cat))}
            />
          );
        })}
        <span className="ml-2 font-mono uppercase tracking-wide text-ink-dim">route:</span>
        {ROUTES.map((r) => {
          const count = routeCounts.get(r) ?? 0;
          return (
            <Pill
              key={r}
              label={r}
              count={count}
              active={routeFilter === r}
              tone={routeTone(r)}
              onClick={() => setRouteFilter((c) => (c === r ? null : r))}
            />
          );
        })}
        <span className="ml-2 font-mono uppercase tracking-wide text-ink-dim">conf:</span>
        <Pill
          label="<60%"
          active={confidenceFilter === 'low'}
          tone="red"
          onClick={() => setConfidenceFilter((c) => (c === 'low' ? null : 'low'))}
        />
        <Pill
          label="60–85%"
          active={confidenceFilter === 'mid'}
          tone="orange"
          onClick={() => setConfidenceFilter((c) => (c === 'mid' ? null : 'mid'))}
        />
        <Pill
          label="≥85%"
          active={confidenceFilter === 'high'}
          tone="green"
          onClick={() => setConfidenceFilter((c) => (c === 'high' ? null : 'high'))}
        />
        {hasFilter && (
          <button
            type="button"
            onClick={() => {
              setCategoryFilter(null);
              setRouteFilter(null);
              setConfidenceFilter(null);
            }}
            className="ml-auto font-mono text-ink-dim hover:text-ink"
          >
            clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-ink-dim">
            {initialRows.length === 0 ? 'No classifications yet' : 'No matches for this filter'}
          </div>
        ) : (
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 bg-bg-panel font-mono uppercase tracking-wide text-ink-dim">
              <tr>
                <Th>When</Th>
                <Th>From</Th>
                <Th>Subject</Th>
                <Th>Category</Th>
                <Th className="text-right">Conf</Th>
                <Th>Route</Th>
                <Th>Outcome</Th>
                <Th>Model</Th>
                <Th className="text-right">Latency</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.log_id} className="border-b border-border-subtle hover:bg-bg-panel/40">
                  <Td className="font-mono tabular-nums text-ink-dim">
                    <TimeAgo iso={row.classified_at} />
                  </Td>
                  <Td className="truncate" title={row.from_addr ?? undefined}>
                    {senderName(row.from_addr)}
                  </Td>
                  <Td
                    className="max-w-[28rem] truncate text-ink-muted"
                    title={row.subject ?? undefined}
                  >
                    {row.subject || '(no subject)'}
                  </Td>
                  <Td>{row.category}</Td>
                  <Td className={`text-right font-mono tabular-nums ${confColor(row.confidence)}`}>
                    {Math.round(row.confidence * 100)}%
                  </Td>
                  <Td className={`font-mono ${routeColor(row.route)}`}>{row.route}</Td>
                  <Td>
                    <OutcomePill status={row.draft_status} />
                  </Td>
                  <Td className="font-mono text-ink-dim">{row.model_version}</Td>
                  <Td className="text-right font-mono tabular-nums text-ink-dim">
                    {row.latency_ms != null ? `${row.latency_ms}ms` : '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}

function Pill({
  label,
  count,
  active,
  tone = 'default',
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  tone?: 'default' | 'green' | 'orange' | 'red';
  onClick: () => void;
}) {
  const tonePalette: Record<string, string> = {
    default: active
      ? 'border-accent-orange/60 bg-accent-orange/10 text-accent-orange'
      : 'border-border bg-bg-panel text-ink-muted hover:text-ink',
    green: active
      ? 'border-accent-green/60 bg-accent-green/10 text-accent-green'
      : 'border-border bg-bg-panel text-ink-muted hover:text-ink',
    orange: active
      ? 'border-accent-orange/60 bg-accent-orange/10 text-accent-orange'
      : 'border-border bg-bg-panel text-ink-muted hover:text-ink',
    red: active
      ? 'border-accent-red/60 bg-accent-red/10 text-accent-red'
      : 'border-border bg-bg-panel text-ink-muted hover:text-ink',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors ${tonePalette[tone]}`}
    >
      <span>{label}</span>
      {count != null && <span className="opacity-60">{count}</span>}
    </button>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-1.5 text-[10px] font-medium ${className}`}>{children}</th>;
}

function Td({
  children,
  className = '',
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={`px-3 py-1.5 text-xs ${className}`} title={title}>
      {children}
    </td>
  );
}

function OutcomePill({ status }: { status: DraftOutcome }) {
  if (status == null) {
    return <span className="font-mono text-[10px] text-ink-dim">no draft</span>;
  }
  const palette: Record<NonNullable<DraftOutcome>, string> = {
    pending: 'text-ink-muted',
    approved: 'text-accent-orange',
    edited: 'text-accent-blue',
    sent: 'text-accent-green',
    rejected: 'text-accent-red',
    failed: 'text-accent-red',
  };
  return <span className={`font-mono text-[10px] uppercase ${palette[status]}`}>{status}</span>;
}

function senderName(addr: string | null): string {
  if (!addr) return 'unknown';
  return addr.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim() || addr.split('@')[0] || addr;
}

function confColor(conf: number): string {
  if (conf >= 0.85) return 'text-accent-green';
  if (conf >= 0.6) return 'text-accent-orange';
  return 'text-accent-red';
}

function routeColor(route: ClassificationRoute): string {
  switch (route) {
    case 'drop':
      return 'text-ink-dim';
    case 'local':
      return 'text-accent-green';
    case 'cloud':
      return 'text-accent-orange';
  }
}

function routeTone(route: ClassificationRoute): 'default' | 'green' | 'orange' | 'red' {
  switch (route) {
    case 'drop':
      return 'default';
    case 'local':
      return 'green';
    case 'cloud':
      return 'orange';
  }
}
