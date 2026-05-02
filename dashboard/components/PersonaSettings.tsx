'use client';

import { useState } from 'react';
import { apiUrl } from '@/lib/api';
import type { Persona } from '@/lib/types';
import { AppNav } from './AppNav';
import { TimeAgo } from './TimeAgo';
import { Toast } from './Toast';

type ToastMsg = { kind: 'success' | 'error'; text: string } | null;

export function PersonaSettings({ initial }: { initial: Persona | null }) {
  const [statistical, setStatistical] = useState(formatJson(initial?.statistical_markers ?? {}));
  const [exemplars, setExemplars] = useState(formatJson(initial?.category_exemplars ?? {}));
  const [statError, setStatError] = useState<string | null>(null);
  const [exemError, setExemError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastMsg>(null);
  const [persona, setPersona] = useState(initial);

  async function onSave() {
    setStatError(null);
    setExemError(null);

    let statParsed: Record<string, unknown>;
    let exemParsed: Record<string, unknown>;
    try {
      statParsed = JSON.parse(statistical);
      if (typeof statParsed !== 'object' || statParsed === null || Array.isArray(statParsed)) {
        throw new Error('must be a JSON object');
      }
    } catch (err) {
      setStatError(err instanceof Error ? err.message : 'invalid JSON');
      return;
    }
    try {
      exemParsed = JSON.parse(exemplars);
      if (typeof exemParsed !== 'object' || exemParsed === null || Array.isArray(exemParsed)) {
        throw new Error('must be a JSON object');
      }
    } catch (err) {
      setExemError(err instanceof Error ? err.message : 'invalid JSON');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/persona'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statistical_markers: statParsed, category_exemplars: exemParsed }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Save failed (${res.status})`);
      setPersona(data.persona as Persona);
      setToast({ kind: 'success', text: 'Persona saved' });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex h-screen flex-col bg-bg-deep text-ink">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-panel px-4">
        <div className="flex items-center gap-3">
          <h1 className="font-sans text-sm font-semibold tracking-tight">MailBox One</h1>
          <AppNav active="settings" />
          <span className="font-mono text-[11px] text-ink-dim">/ Persona</span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 p-4 lg:p-6">
          {/* Metadata strip */}
          <section className="rounded border border-border bg-bg-panel p-4">
            <h2 className="mb-3 font-sans text-sm font-semibold">Persona snapshot</h2>
            <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 font-mono text-xs">
              <dt className="text-ink-dim">customer_key:</dt>
              <dd className="text-ink">{persona?.customer_key ?? 'default'}</dd>
              <dt className="text-ink-dim">source_email_count:</dt>
              <dd className="text-ink tabular-nums">{persona?.source_email_count ?? 0}</dd>
              <dt className="text-ink-dim">last_refreshed_at:</dt>
              <dd className="text-ink-muted">
                {persona?.last_refreshed_at ? <TimeAgo iso={persona.last_refreshed_at} /> : 'never'}
              </dd>
              <dt className="text-ink-dim">updated_at:</dt>
              <dd className="text-ink-muted">
                {persona?.updated_at ? <TimeAgo iso={persona.updated_at} /> : '—'}
              </dd>
            </dl>
            {!persona && (
              <p className="mt-3 rounded border border-accent-orange/40 bg-accent-orange/10 p-2 text-xs text-accent-orange">
                No persona row yet. Saving will create the default row.
              </p>
            )}
          </section>

          {/* Statistical markers editor */}
          <Editor
            label="statistical_markers"
            help="Voice profile fingerprint (avg sentence length, common words, signature, tone descriptors). Auto-populated by STAQPRO-153 when extraction lands; edit here to override."
            value={statistical}
            onChange={setStatistical}
            error={statError}
          />

          {/* Category exemplars editor */}
          <Editor
            label="category_exemplars"
            help="Few-shot example pairs per classification category (reorder, scheduling, follow_up, etc.). Each entry is a sample inbound + ideal reply that drives the per-route drafting prompt."
            value={exemplars}
            onChange={setExemplars}
            error={exemError}
          />

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onSave}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded bg-accent-orange px-4 py-2 font-sans text-sm font-semibold text-bg-deep transition-colors hover:bg-accent-orange/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save persona'}
            </button>
            <p className="font-mono text-[11px] text-ink-dim">
              Edits are upserted into <code>mailbox.persona</code>; the next draft consumes them.
            </p>
          </div>
        </div>
      </div>

      {toast && <Toast {...toast} onDismiss={() => setToast(null)} />}
    </main>
  );
}

function Editor({
  label,
  help,
  value,
  onChange,
  error,
}: {
  label: string;
  help: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
}) {
  return (
    <section className="rounded border border-border bg-bg-panel p-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={label} className="font-mono text-xs uppercase tracking-wider text-ink">
          {label}
        </label>
        {error && <span className="font-mono text-[11px] text-accent-red">JSON: {error}</span>}
      </div>
      <p className="mb-2 text-xs text-ink-muted">{help}</p>
      <textarea
        id={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        rows={14}
        className={`w-full rounded border bg-bg-deep p-3 font-mono text-xs leading-relaxed text-ink focus:outline-none ${
          error ? 'border-accent-red/60' : 'border-border-subtle focus:border-accent-orange/60'
        }`}
      />
    </section>
  );
}

function formatJson(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return '{}';
  }
}
