'use client';

import { Check, Pencil, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ImapConnectForm } from '@/app/onboarding/email-connect/ImapConnectForm';
import { AppShell } from '@/components/AppShell';
import { TimeAgo } from '@/components/TimeAgo';
import { Toast } from '@/components/Toast';
import { apiUrl } from '@/lib/api';
import type { AccountDetail } from '@/lib/queries-accounts';
import { MAIL_PROVIDERS, type MailProviderKind } from '@/lib/types';

// MBOX-366 (MBOX-162 V5) — connected-inbox registry UI. Add / relabel /
// set-default / remove the mailboxes this appliance serves. Matches the
// settings-page style (AppShell + bg-panel cards + Tailwind v4 @theme tokens),
// mirroring settings/vip and settings/auto-send.
//
// Honest bound (surfaced inline below): creating a row here lights up the V3
// account selector/badge + V2 per-account persona/RAG scoping, but does NOT
// connect the inbox's Gmail OAuth or wire n8n ingestion — that stays operator /
// white-glove work (multi-provider MBOX-355/356).

type ToastMsg = { kind: 'success' | 'error'; text: string } | null;

const PROVIDER_LABELS: Record<MailProviderKind, string> = {
  gmail: 'Gmail',
  imap: 'IMAP',
  microsoft: 'Microsoft 365',
};

function labelFor(a: AccountDetail): string {
  return a.display_label ?? a.email_address;
}

export function AccountsSettings({
  initial,
  loadError,
}: {
  initial: AccountDetail[];
  loadError: string | null;
}) {
  const [accounts, setAccounts] = useState<AccountDetail[]>(initial);
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState('');
  const [provider, setProvider] = useState<MailProviderKind>('gmail');
  const [busy, setBusy] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [toast, setToast] = useState<ToastMsg>(null);

  // Replace one account row in place (keeps the default-first / id ordering the
  // server returns by re-sorting after a default swap).
  function upsertRow(next: AccountDetail) {
    setAccounts((prev) => {
      const merged = prev.some((a) => a.id === next.id)
        ? prev.map((a) => (a.id === next.id ? next : a))
        : [...prev, next];
      // A set-default swap flips is_default on two rows; re-fetch isn't needed
      // because the server only returns the promoted one — clear the others
      // locally so exactly one default shows.
      const deduped = next.is_default
        ? merged.map((a) => (a.id === next.id ? a : { ...a, is_default: false }))
        : merged;
      return [...deduped].sort(
        (a, b) => Number(b.is_default) - Number(a.is_default) || a.id - b.id,
      );
    });
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl('/api/accounts'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_address: trimmed,
          display_label: label.trim() || undefined,
          provider,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          data?.error === 'validation_failed'
            ? (data.issues?.[0]?.message ?? 'Invalid entry')
            : (data?.message ?? data?.error ?? `Add failed (${res.status})`);
        throw new Error(msg);
      }
      const added = data.account as AccountDetail;
      setAccounts((prev) =>
        [...prev.filter((a) => a.id !== added.id), added].sort(
          (a, b) => Number(b.is_default) - Number(a.is_default) || a.id - b.id,
        ),
      );
      setEmail('');
      setLabel('');
      setProvider('gmail');
      setToast({ kind: 'success', text: `Connected ${added.email_address}` });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Add failed' });
    } finally {
      setBusy(false);
    }
  }

  // MBOX-357 — after the IMAP connect form saves (its own probe + encrypted
  // credential flow via /api/accounts/imap), re-pull the detailed list so the
  // new inbox appears with its provider/default badges. Non-fatal on failure.
  async function refresh() {
    try {
      const res = await fetch(apiUrl('/api/accounts?detail=1'));
      const data = await res.json().catch(() => null);
      if (res.ok && Array.isArray(data?.accounts)) {
        setAccounts(
          (data.accounts as AccountDetail[]).sort(
            (a, b) => Number(b.is_default) - Number(a.is_default) || a.id - b.id,
          ),
        );
      }
    } catch {
      // best-effort — the row will show on the next page load
    }
  }

  async function onMakeDefault(a: AccountDetail) {
    if (a.is_default) return;
    setRowBusyId(a.id);
    try {
      const res = await fetch(apiUrl(`/api/accounts/${a.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ make_default: true }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message ?? data?.error ?? `Failed (${res.status})`);
      upsertRow(data.account as AccountDetail);
      setToast({ kind: 'success', text: `${labelFor(a)} is now the default inbox` });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setRowBusyId(null);
    }
  }

  function startEdit(a: AccountDetail) {
    setEditingId(a.id);
    setEditLabel(a.display_label ?? '');
  }

  async function onSaveLabel(a: AccountDetail) {
    setRowBusyId(a.id);
    try {
      const res = await fetch(apiUrl(`/api/accounts/${a.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_label: editLabel.trim() === '' ? null : editLabel.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message ?? data?.error ?? `Failed (${res.status})`);
      upsertRow(data.account as AccountDetail);
      setEditingId(null);
      setToast({ kind: 'success', text: 'Label updated' });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setRowBusyId(null);
    }
  }

  async function onDelete(a: AccountDetail) {
    setRowBusyId(a.id);
    try {
      const res = await fetch(apiUrl(`/api/accounts/${a.id}`), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message ?? data?.error ?? `Delete failed (${res.status})`);
      }
      setAccounts((prev) => prev.filter((row) => row.id !== a.id));
      setToast({ kind: 'success', text: `Removed ${a.email_address}` });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Delete failed' });
    } finally {
      setRowBusyId(null);
    }
  }

  return (
    <AppShell active={{ kind: 'surface', surface: 'inboxes' }}>
      <header className="flex h-12 shrink-0 items-center border-b border-border-subtle bg-bg-panel px-4">
        <span className="font-mono text-[11px] text-ink-dim">Inboxes</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-4 lg:p-6">
          <section>
            <h2 className="mb-1 font-sans text-base font-semibold">Connected inboxes</h2>
            <p className="text-sm text-ink-muted">
              The email identities this appliance serves. Each inbox drafts in its own voice and
              keeps its own history. The default inbox receives any mail that isn’t routed to a
              specific account.
            </p>
          </section>

          {/* Honest bound — registry vs. live mail I/O */}
          <div className="rounded-sm border border-accent-orange/40 bg-accent-orange/10 p-3 text-xs text-ink-muted">
            <p className="mb-1 font-medium text-ink">Connecting an inbox is a two-step process</p>
            <p>
              Adding an inbox registers it so the queue selector, per-account voice, and history
              scoping engage. For <span className="font-semibold">IMAP/SMTP</span> your credentials
              are tested and stored here; for Gmail your operator wires the OAuth credential
              separately. Either way, live mail flow (n8n ingestion) is completed during operator
              setup — until then a new inbox simply has no mail flowing to it.
            </p>
          </div>

          {loadError && (
            <div className="rounded-sm border border-accent-red/40 bg-accent-red/10 p-3 text-xs text-accent-red">
              <p className="mb-1 font-medium">Failed to load accounts</p>
              <p className="font-mono">{loadError}</p>
            </div>
          )}

          {/* Add form. Provider picker is always shown; IMAP/SMTP swaps in the
              full connect form (MBOX-357 — host/port/credentials + a live
              test-connection probe, persisted via /api/accounts/imap). Gmail and
              Microsoft register a bare row (POST /api/accounts) — their live I/O
              is operator/OAuth or P2 work. */}
          <div className="space-y-3 rounded-sm border border-border bg-bg-panel p-4">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[11px] uppercase tracking-wider text-ink-dim">
                Provider
              </span>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as MailProviderKind)}
                className="w-fit rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink"
              >
                {MAIL_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>

            {provider === 'imap' ? (
              <ImapConnectForm
                endpoint="/api/accounts/imap"
                showNextPrompt={false}
                onSaved={() => {
                  void refresh();
                  setToast({ kind: 'success', text: 'Mailbox connected' });
                }}
              />
            ) : (
              <form onSubmit={onAdd} className="space-y-3">
                <label className="flex min-w-[16rem] flex-col gap-1">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-ink-dim">
                    Email address
                  </span>
                  <input
                    type="text"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="founder@startup.com"
                    className="rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-dim"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-mono text-[11px] uppercase tracking-wider text-ink-dim">
                    Label (optional)
                  </span>
                  <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Consulting, Founder, Support, …"
                    className="rounded-sm border border-border-subtle bg-bg-deep px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-dim"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy || email.trim().length === 0}
                  className="inline-flex items-center gap-1.5 rounded-sm bg-accent-orange px-4 py-2 font-sans text-sm font-semibold text-bg-deep transition-colors hover:bg-accent-orange/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? 'Connecting…' : 'Register inbox'}
                </button>
              </form>
            )}
          </div>

          {/* List */}
          <section>
            <h3 className="mb-2 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Inboxes ({accounts.length})
            </h3>
            {accounts.length === 0 ? (
              <p className="rounded-sm border border-border-subtle bg-bg-panel p-3 text-sm text-ink-muted">
                No inboxes yet. Add one above.
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle rounded-sm border border-border-subtle bg-bg-panel">
                {accounts.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      {editingId === a.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={editLabel}
                            onChange={(e) => setEditLabel(e.target.value)}
                            placeholder={a.email_address}
                            className="min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-deep px-2 py-1 font-mono text-xs text-ink placeholder:text-ink-dim"
                          />
                          <button
                            type="button"
                            onClick={() => onSaveLabel(a)}
                            disabled={rowBusyId === a.id}
                            className="inline-flex items-center gap-1 rounded-sm bg-accent-orange px-2 py-1 font-mono text-[11px] font-semibold text-bg-deep disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="rounded-sm border border-border-subtle px-2 py-1 font-mono text-[11px] text-ink-muted"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-2">
                            <span className="truncate font-sans text-sm font-medium text-ink">
                              {labelFor(a)}
                            </span>
                            {a.is_default && (
                              <span className="inline-flex items-center gap-1 rounded-sm border border-accent-orange/50 bg-accent-orange/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-accent-orange">
                                <Star size={10} />
                                Default
                              </span>
                            )}
                            <span className="rounded-sm border border-border-subtle px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
                              {PROVIDER_LABELS[a.provider]}
                            </span>
                          </div>
                          <div className="font-mono text-[11px] text-ink-dim">
                            {a.display_label ? `${a.email_address} · ` : ''}added{' '}
                            <TimeAgo iso={a.created_at} />
                          </div>
                        </>
                      )}
                    </div>

                    {editingId !== a.id && (
                      <div className="flex shrink-0 items-center gap-1">
                        {!a.is_default && (
                          <button
                            type="button"
                            onClick={() => onMakeDefault(a)}
                            disabled={rowBusyId === a.id}
                            aria-label={`Make ${labelFor(a)} the default inbox`}
                            className="inline-flex items-center gap-1 rounded-sm border border-border-subtle px-2 py-1 font-mono text-[11px] text-ink-muted transition-colors hover:border-accent-orange/60 hover:text-accent-orange disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Check size={12} />
                            Set default
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => startEdit(a)}
                          aria-label={`Rename ${labelFor(a)}`}
                          className="inline-flex items-center gap-1 rounded-sm border border-border-subtle px-2 py-1 font-mono text-[11px] text-ink-muted transition-colors hover:border-border hover:text-ink"
                        >
                          <Pencil size={12} />
                          Rename
                        </button>
                        {!a.is_default && (
                          <button
                            type="button"
                            onClick={() => onDelete(a)}
                            disabled={rowBusyId === a.id}
                            aria-label={`Remove ${a.email_address}`}
                            className="inline-flex items-center gap-1 rounded-sm border border-border-subtle px-2 py-1 font-mono text-[11px] text-ink-muted transition-colors hover:border-accent-red/60 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Trash2 size={12} />
                            Remove
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {toast && <Toast {...toast} onDismiss={() => setToast(null)} />}
    </AppShell>
  );
}
