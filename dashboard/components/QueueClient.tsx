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

  // Track IDs we've already shown so a poll doesn't double-count "new".
  const knownIds = useRef<Set<number>>(
    new Set(initialActive.map((d) => d.id)),
  );

  const fetchData = useCallback(async (silent: boolean) => {
    try {
      const [actRes, failRes] = await Promise.all([
        fetch('/api/drafts?status=pending,edited&limit=50', {
          cache: 'no-store',
        }),
        fetch('/api/drafts?status=failed&limit=50', { cache: 'no-store' }),
      ]);
      if (!actRes.ok || !failRes.ok) return;
      const actJson = await actRes.json();
      const failJson = await failRes.json();
      const nextActive: DraftWithMessage[] = actJson.drafts ?? [];
      const nextFailed: DraftWithMessage[] = failJson.drafts ?? [];

      if (silent) {
        nextActive.forEach((d) => knownIds.current.add(d.id));
      } else {
        const fresh = nextActive
          .map((d) => d.id)
          .filter((id) => !knownIds.current.has(id));
        if (fresh.length > 0) {
          setNewCount((c) => c + fresh.length);
          fresh.forEach((id) => knownIds.current.add(id));
        }
      }

      setActive(nextActive);
      setFailed(nextFailed);
    } catch {
      // Network error — next poll will retry. Don't surface a toast for
      // background polls (would be noisy for transient connectivity blips).
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => fetchData(false), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  const dismissToast = () => setToast(null);
  const dismissNewDrafts = () => setNewCount(0);

  async function fireAction(
    kind: 'approve' | 'reject',
    draft: DraftWithMessage,
  ) {
    setBusy({ draftId: draft.id, kind });
    try {
      const res = await fetch(`/api/drafts/${draft.id}/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error ?? `${kind} failed (${res.status})`);
      }
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
      if (!res.ok) {
        throw new Error(data?.error ?? `Retry failed (${res.status})`);
      }
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
      if (!res.ok) {
        throw new Error(data?.error ?? `Edit failed (${res.status})`);
      }
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
  const busyKindFor = (id: number): ActionKind | null =>
    busy?.draftId === id && busy.kind !== 'retry'
      ? (busy.kind as ActionKind)
      : null;
  const busyRetryId =
    busy?.kind === 'retry' ? busy.draftId : null;

  return (
    <>
      <header className="mb-6 flex items-center justify-between">
        <h1 className="font-sans text-xl font-semibold tracking-tight">
          MailBox One
        </h1>
        <span className="rounded-full border border-border bg-bg-panel px-3 py-1 font-mono text-xs text-ink-muted">
          {visibleActive.length} pending
        </span>
      </header>

      <NewDraftsBanner count={newCount} onDismiss={dismissNewDrafts} />

      <FailedSends
        drafts={failed}
        busyId={busyRetryId}
        onRetry={fireRetry}
      />

      {visibleActive.length === 0 ? (
        <EmptyState />
      ) : (
        <Body
          drafts={visibleActive}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          busyKindFor={busyKindFor}
          onApprove={(d) => fireAction('approve', d)}
          onEdit={setEditing}
          onReject={(d) => fireAction('reject', d)}
        />
      )}

      {editing && (
        <EditModal
          draft={editing}
          onSave={onEditSave}
          onClose={() => setEditing(null)}
        />
      )}
      {toast && <Toast {...toast} onDismiss={dismissToast} />}
    </>
  );
}

function Body({
  drafts,
  selectedId,
  setSelectedId,
  busyKindFor,
  onApprove,
  onEdit,
  onReject,
}: {
  drafts: DraftWithMessage[];
  selectedId: number | null;
  setSelectedId: (fn: (id: number | null) => number | null) => void;
  busyKindFor: (id: number) => ActionKind | null;
  onApprove: (d: DraftWithMessage) => void;
  onEdit: (d: DraftWithMessage) => void;
  onReject: (d: DraftWithMessage) => void;
}) {
  const selected = drafts.find((d) => d.id === selectedId) ?? drafts[0];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,28rem)_1fr] lg:gap-6">
      <ul className="space-y-3">
        {drafts.map((draft) => {
          const isSelected = draft.id === selectedId;
          return (
            <li key={draft.id}>
              <DraftCard
                draft={draft}
                isSelected={isSelected}
                onToggle={() =>
                  setSelectedId((id) =>
                    id === draft.id ? null : draft.id,
                  )
                }
              />
              {isSelected && (
                <div className="mt-3 lg:hidden">
                  <DraftDetail
                    draft={draft}
                    busy={busyKindFor(draft.id)}
                    onApprove={() => onApprove(draft)}
                    onEdit={() => onEdit(draft)}
                    onReject={() => onReject(draft)}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <aside className="hidden lg:sticky lg:top-6 lg:block lg:self-start">
        <DraftDetail
          draft={selected}
          busy={busyKindFor(selected.id)}
          onApprove={() => onApprove(selected)}
          onEdit={() => onEdit(selected)}
          onReject={() => onReject(selected)}
        />
      </aside>
    </div>
  );
}
