'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DraftWithMessage } from '@/lib/types';
import type { ActionKind } from './ActionButtons';
import { DraftCard } from './DraftCard';
import { DraftDetail } from './DraftDetail';
import { EditModal } from './EditModal';
import { EmptyState } from './EmptyState';
import { FailedSends } from './FailedSends';
import { NewDraftsBanner } from './NewDraftsBanner';
import { Toast } from './Toast';

const POLL_INTERVAL_MS = 30_000;

type Busy = { draftId: number; kind: ActionKind | 'retry' } | null;
type ToastMsg = { kind: 'success' | 'error'; text: string } | null;

interface Props {
  initialActive: DraftWithMessage[];
  initialFailed: DraftWithMessage[];
}

export function QueueClient({ initialActive, initialFailed }: Props) {
  const [active, setActive] = useState(initialActive);
  const [failed, setFailed] = useState(initialFailed);
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<Busy>(null);
  const [editing, setEditing] = useState<DraftWithMessage | null>(null);
  const [toast, setToast] = useState<ToastMsg>(null);
  const [newCount, setNewCount] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(
    initialActive.length > 0 ? initialActive[0].id : null,
  );
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const knownIds = useRef<Set<number>>(new Set(initialActive.map((d) => d.id)));

  const fetchData = useCallback(async (silent: boolean) => {
    try {
      const [actRes, failRes] = await Promise.all([
        fetch('/api/drafts?status=pending,edited&limit=50', { cache: 'no-store' }),
        fetch('/api/drafts?status=failed&limit=50', { cache: 'no-store' }),
      ]);
      if (!actRes.ok || !failRes.ok) return;
      const actJson = await actRes.json();
      const failJson = await failRes.json();
      const nextActive: DraftWithMessage[] = actJson.drafts ?? [];
      const nextFailed: DraftWithMessage[] = failJson.drafts ?? [];

      if (silent) {
        for (const d of nextActive) knownIds.current.add(d.id);
      } else {
        const fresh = nextActive.map((d) => d.id).filter((id) => !knownIds.current.has(id));
        if (fresh.length > 0) {
          setNewCount((c) => c + fresh.length);
          for (const id of fresh) knownIds.current.add(id);
        }
      }

      setActive(nextActive);
      setFailed(nextFailed);
    } catch {
      // Background poll — swallow transient errors.
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => fetchData(false), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  const dismissToast = () => setToast(null);
  const dismissNewDrafts = () => setNewCount(0);

  async function fireAction(kind: 'approve' | 'reject', draft: DraftWithMessage) {
    setBusy({ draftId: draft.id, kind });
    try {
      const res = await fetch(`/api/drafts/${draft.id}/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `${kind} failed (${res.status})`);
      setRemoved((s) => {
        const next = new Set(s);
        next.add(draft.id);
        return next;
      });
      setToast({
        kind: 'success',
        text: kind === 'approve' ? 'Approved — sending' : 'Rejected',
      });
      fetchData(true);
    } catch (err) {
      setToast({
        kind: 'error',
        text: err instanceof Error ? err.message : `${kind} failed`,
      });
    } finally {
      setBusy(null);
    }
  }

  async function fireRetry(draft: DraftWithMessage) {
    setBusy({ draftId: draft.id, kind: 'retry' });
    try {
      const res = await fetch(`/api/drafts/${draft.id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Retry failed (${res.status})`);
      setToast({ kind: 'success', text: 'Retry — sending' });
      fetchData(true);
    } catch (err) {
      setToast({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Retry failed',
      });
    } finally {
      setBusy(null);
    }
  }

  async function onEditSave(body: string, subject: string | null) {
    if (!editing) return;
    setBusy({ draftId: editing.id, kind: 'edit' });
    try {
      const res = await fetch(`/api/drafts/${editing.id}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft_body: body, draft_subject: subject }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Edit failed (${res.status})`);
      setEditing(null);
      setToast({ kind: 'success', text: 'Saved' });
      fetchData(true);
    } catch (err) {
      setBusy(null);
      throw err;
    } finally {
      setBusy((b) => (b?.kind === 'edit' ? null : b));
    }
  }

  const visibleActive = active.filter((d) => !removed.has(d.id));
  const selected = visibleActive.find((d) => d.id === selectedId) ?? visibleActive[0] ?? null;
  const busyKindFor = (id: number): ActionKind | null =>
    busy?.draftId === id && busy.kind !== 'retry' ? (busy.kind as ActionKind) : null;
  const busyRetryId = busy?.kind === 'retry' ? busy.draftId : null;

  return (
    <main className="flex h-screen flex-col bg-bg-deep text-ink">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-panel px-4">
        <div className="flex items-center gap-3">
          <h1 className="font-sans text-sm font-semibold tracking-tight">MailBox One</h1>
          <span className="rounded-full border border-border bg-bg-deep px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-muted">
            {visibleActive.length} pending
          </span>
          {failed.length > 0 && (
            <span className="rounded-full border border-accent-red/40 bg-accent-red/10 px-2 py-0.5 font-mono text-[11px] tabular-nums text-accent-red">
              {failed.length} failed
            </span>
          )}
        </div>
      </header>

      {/* Two-pane body */}
      <div className="flex min-h-0 flex-1">
        {/* Left list pane */}
        <aside
          className={`flex w-full shrink-0 flex-col border-r border-border-subtle md:w-80 ${
            mobileDetailOpen ? 'hidden md:flex' : 'flex'
          }`}
        >
          {(failed.length > 0 || newCount > 0) && (
            <div className="space-y-2 border-b border-border-subtle p-2">
              <FailedSends drafts={failed} busyId={busyRetryId} onRetry={fireRetry} />
              <NewDraftsBanner count={newCount} onDismiss={dismissNewDrafts} />
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visibleActive.length === 0 ? (
              <EmptyState />
            ) : (
              <ul className="divide-y divide-border-subtle">
                {visibleActive.map((draft) => (
                  <li key={draft.id}>
                    <DraftCard
                      draft={draft}
                      isSelected={draft.id === selected?.id}
                      onSelect={() => {
                        setSelectedId(draft.id);
                        setMobileDetailOpen(true);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* Right detail pane */}
        <section
          className={`min-w-0 flex-1 flex-col bg-bg-deep ${
            mobileDetailOpen ? 'flex' : 'hidden md:flex'
          }`}
        >
          {selected ? (
            <>
              {/* Mobile back button */}
              <div className="flex h-10 shrink-0 items-center border-b border-border-subtle px-3 md:hidden">
                <button
                  type="button"
                  onClick={() => setMobileDetailOpen(false)}
                  className="font-mono text-xs text-ink-muted hover:text-ink"
                >
                  ← Back to queue
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
                <DraftDetail
                  draft={selected}
                  busy={busyKindFor(selected.id)}
                  onApprove={() => fireAction('approve', selected)}
                  onEdit={() => setEditing(selected)}
                  onReject={() => fireAction('reject', selected)}
                />
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-ink-dim">
              No draft selected
            </div>
          )}
        </section>
      </div>

      {editing && (
        <EditModal draft={editing} onSave={onEditSave} onClose={() => setEditing(null)} />
      )}
      {toast && <Toast {...toast} onDismiss={dismissToast} />}
    </main>
  );
}
