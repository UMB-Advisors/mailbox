'use client';

import { BookOpen, ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiUrl } from '@/lib/api';
import { TimeAgo } from './TimeAgo';

// STAQPRO-331 #2 — "Sources used" panel inside DraftDetail. Resolves
// drafts.rag_context_refs (Qdrant point UUIDs) back to the source messages
// the drafter saw, so an operator rejecting "factually inaccurate" or
// "missing context" can diagnose whether retrieval pulled the right
// counterparty history — or no history at all.

interface SourceRef {
  point_id: string;
  message_id: string;
  sender: string;
  recipient: string;
  subject: string | null;
  body_excerpt: string;
  sent_at: string;
  direction: 'inbound' | 'outbound';
  classification_category: string | null;
}

interface RagRefsResponse {
  reason: string;
  refs: SourceRef[];
  qdrant_error?: string;
  unresolved_point_ids?: string[];
}

interface Props {
  draftId: number;
}

const REASON_LABEL: Record<string, string> = {
  ok: 'retrieval succeeded',
  cloud_gated: 'cloud-route draft — RAG retrieval is disabled by privacy default for cloud drafts',
  embed_unavailable: 'embedding service was unreachable when this draft was assembled',
  qdrant_unavailable: 'vector store was unreachable when this draft was assembled',
  no_hits: 'no prior counterparty messages matched',
  disabled: 'RAG was disabled by env override (eval mode)',
  none: 'pre-RAG draft (predates the retrieval pipeline)',
};

export function SourcesUsedPanel({ draftId }: Props) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<RagRefsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy-load: only fetch when the operator expands the panel. Avoids one
  // extra Qdrant round-trip per draft in the common case (operator never
  // opens it for high-confidence drafts they approve without inspection).
  useEffect(() => {
    if (!open || data !== null || loading) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/drafts/${draftId}/rag-refs`), { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as RagRefsResponse;
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'unknown error');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, draftId, data, loading]);

  // No explicit reset effect — parent passes `key={draft.id}` so React
  // unmounts + remounts the panel when the operator switches drafts.
  // That naturally resets all local state (open / data / loading / error)
  // without an effect that biome's exhaustive-deps would flag.

  const count = data?.refs.length ?? null;
  return (
    <section className="rounded border border-border-subtle bg-bg-deep">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 p-3 font-sans text-sm text-ink-muted hover:text-ink"
      >
        <BookOpen size={14} aria-hidden />
        <span>Sources used</span>
        {count !== null && (
          <span className="rounded-full border border-border bg-bg-panel px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-ink-dim">
            {count}
          </span>
        )}
        <ChevronDown
          size={14}
          className={`ml-auto transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>
      {open && (
        <div className="border-t border-border-subtle p-3">
          {loading && <p className="font-sans text-xs text-ink-dim">Loading…</p>}
          {error && (
            <p className="font-sans text-xs text-accent-red">
              Failed to load sources: <span className="font-mono">{error}</span>
            </p>
          )}
          {data && <SourcesContent data={data} />}
        </div>
      )}
    </section>
  );
}

function SourcesContent({ data }: { data: RagRefsResponse }) {
  if (data.refs.length === 0) {
    return (
      <div className="space-y-1">
        <p className="font-sans text-xs text-ink-muted">No sources retrieved for this draft.</p>
        <p className="font-sans text-xs text-ink-dim">
          Reason: <span className="font-mono text-ink-muted">{data.reason}</span>
          {REASON_LABEL[data.reason] && (
            <span className="ml-1 text-ink-dim">— {REASON_LABEL[data.reason]}</span>
          )}
        </p>
        {data.qdrant_error && data.unresolved_point_ids && data.unresolved_point_ids.length > 0 && (
          <p className="font-sans text-xs text-accent-orange">
            ⚠ Qdrant unreachable ({data.qdrant_error}); {data.unresolved_point_ids.length} ref
            {data.unresolved_point_ids.length === 1 ? '' : 's'} could not be resolved right now.
          </p>
        )}
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {data.refs.map((ref) => (
        <li key={ref.point_id} className="rounded border border-border-subtle bg-bg-panel p-2">
          <div className="mb-1 flex items-baseline gap-2">
            <span
              className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                ref.direction === 'outbound'
                  ? 'border border-accent-blue/40 bg-accent-blue/10 text-accent-blue'
                  : 'border border-border bg-bg-deep text-ink-muted'
              }`}
            >
              {ref.direction}
            </span>
            <span className="truncate font-mono text-xs text-ink-muted">
              {ref.direction === 'outbound' ? `→ ${ref.recipient}` : `from ${ref.sender}`}
            </span>
            <span className="ml-auto whitespace-nowrap font-mono text-[11px] text-ink-dim">
              <TimeAgo iso={ref.sent_at} />
            </span>
          </div>
          {ref.subject && (
            <p className="mb-1 truncate font-sans text-sm font-medium text-ink">{ref.subject}</p>
          )}
          <p className="font-sans text-xs leading-relaxed text-ink-muted">
            {truncate(ref.body_excerpt, 240)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n).trimEnd()}…`;
}
