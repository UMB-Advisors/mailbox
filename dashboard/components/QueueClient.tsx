'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from '@/lib/api';
import type { DraftWithMessage } from '@/lib/types';
import type { ActionKind } from './ActionButtons';
import { AppNav } from './AppNav';
import { DraftCard } from './DraftCard';
import { DraftDetail } from './DraftDetail';
import { EditModal } from './EditModal';
import { EmptyState } from './EmptyState';
import { NewDraftsBanner } from './NewDraftsBanner';
import { StuckApproved } from './StuckApproved';
import { Toast } from './Toast';

const POLL_INTERVAL_MS = 30_000;
const STUCK_APPROVED_THRESHOLD_MS = 5 * 60 * 1000;

type Busy = { draftId: number; kind: ActionKind | 'retry' } | null;
type ToastMsg = { kind: 'success' | 'error'; text: string } | null;
type View = 'pending' | 'sent';

interface Props {
  initialActive: DraftWithMessage[];
  initialSent: DraftWithMessage[];
}

export function QueueClient({ initialActive, initialSent }: Props) {
  const [active, setActive] = useState(initialActive);
  const [sent, setSent] = useState(initialSent);
  const [view, setView] = useState<View>('pending');
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
      const [actRes, sentRes] = await Promise.all([
        fetch(apiUrl('/api/drafts?status=pending,edited&limit=50'), { cache: 'no-store' }),
        fetch(apiUrl('/api/drafts?status=approved,sent,rejected&limit=50'), {
          cache: 'no-store',
        }),
      ]);
      if (!actRes.ok || !sentRes.ok) return;
      const actJson = await actRes.json();
      const sentJson = await sentRes.json();
      const nextActive: DraftWithMessage[] = actJson.drafts ?? [];
      const nextSent: DraftWithMessage[] = sentJson.drafts ?? [];

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
      setSent(nextSent);
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
      const res = await fetch(apiUrl(`/api/drafts/${draft.id}/${kind}`), {
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
      // STAQPRO-148-followup (Delphi UX pass) — auto-advance to the next
      // draft so the operator can click Approve / Reject repeatedly (or
      // hold `a` once keyboard nav lands) and burn through high-confidence
      // drafts without re-selecting.
      //
      // Snapshot the visible list BEFORE the removal, find the actioned
      // draft's position, then pick the next entry in the post-removal
      // list. Falls back to the previous entry when actioning the last
      // draft, or null when the queue empties.
      const oldVisible = view === 'pending' ? active.filter((d) => !removed.has(d.id)) : sent;
      const idx = oldVisible.findIndex((d) => d.id === draft.id);
      const newVisible = oldVisible.filter((_, i) => i !== idx);
      const next = newVisible[idx] ?? newVisible[idx - 1] ?? null;
      setSelectedId(next?.id ?? null);
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
      const res = await fetch(apiUrl(`/api/drafts/${draft.id}/retry`), {
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
      const res = await fetch(apiUrl(`/api/drafts/${editing.id}/edit`), {
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
  // STAQPRO-202 — drafts stuck at status='approved' beyond the webhook
  // timeout window. Sole operator recovery surface for send-side failures
  // (the 'failed' status was retired in migration 016 — see CLAUDE.md
  // Conventions > Draft status state machine). Warning chip below.
  const stuckApproved = sent.filter((d) => {
    if (d.status !== 'approved') return false;
    const updated = d.updated_at ? new Date(d.updated_at).getTime() : NaN;
    if (!Number.isFinite(updated)) return false;
    return Date.now() - updated > STUCK_APPROVED_THRESHOLD_MS;
  });
  const list = view === 'pending' ? visibleActive : sent;
  const selected = list.find((d) => d.id === selectedId) ?? list[0] ?? null;
  const busyKindFor = (id: number): ActionKind | null =>
    busy?.draftId === id && busy.kind !== 'retry' ? (busy.kind as ActionKind) : null;
  const busyRetryId = busy?.kind === 'retry' ? busy.draftId : null;

  // STAQPRO-148-followup (Delphi UX pass) — keyboard nav for desktop
  // operators. j/k or arrow keys move between drafts; a approves; e edits;
  // x rejects. NOT 'r' (Cmd+R refresh muscle-memory creates accidental-
  // reject risk per Eric's call-out). Modifier-key check bails on
  // Cmd/Ctrl/Alt so genuine Cmd+letter browser shortcuts pass through.
  // Guards: skip when typing in input/textarea/select OR when the edit
  // modal is open OR when an action is already in flight.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (editing !== null) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const currentList = view === 'pending' ? visibleActive : sent;
      const currentIndex =
        selectedId == null ? -1 : currentList.findIndex((d) => d.id === selectedId);

      switch (e.key) {
        case 'j':
        case 'ArrowDown': {
          e.preventDefault();
          const nextDraft = currentList[currentIndex + 1];
          if (nextDraft) setSelectedId(nextDraft.id);
          return;
        }
        case 'k':
        case 'ArrowUp': {
          e.preventDefault();
          const prevDraft = currentList[currentIndex - 1];
          if (prevDraft) setSelectedId(prevDraft.id);
          return;
        }
        case 'a': {
          if (!selected || view === 'sent' || busy) return;
          e.preventDefault();
          fireAction('approve', selected);
          return;
        }
        case 'e': {
          if (!selected || view === 'sent' || busy) return;
          e.preventDefault();
          setEditing(selected);
          return;
        }
        case 'x': {
          if (!selected || view === 'sent' || busy) return;
          e.preventDefault();
          fireAction('reject', selected);
          return;
        }
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

  function switchView(next: View) {
    if (next === view) return;
    setView(next);
    const nextList = next === 'pending' ? visibleActive : sent;
    setSelectedId(nextList[0]?.id ?? null);
  }

  return (
    <main className="flex h-screen flex-col bg-bg-deep text-ink">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-panel px-4">
        <div className="flex items-center gap-3">
          <h1 className="font-sans text-sm font-semibold tracking-tight">MailBox One</h1>
          <AppNav active="queue" />
          <span className="rounded-full border border-border bg-bg-deep px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-muted">
            {visibleActive.length} pending
          </span>
          {stuckApproved.length > 0 && (
            <span className="rounded-full border border-accent-orange/40 bg-accent-orange/10 px-2 py-0.5 font-mono text-[11px] tabular-nums text-accent-orange">
              {stuckApproved.length} stuck
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
          {/* Folder switcher (Outlook-style) */}
          <nav className="flex shrink-0 border-b border-border-subtle">
            <FolderTab
              label="Inbox"
              count={visibleActive.length}
              active={view === 'pending'}
              onClick={() => switchView('pending')}
            />
            <FolderTab
              label="Sent"
              count={sent.length}
              active={view === 'sent'}
              onClick={() => switchView('sent')}
            />
          </nav>

          {view === 'pending' && (stuckApproved.length > 0 || newCount > 0) && (
            <div className="space-y-2 border-b border-border-subtle p-2">
              <StuckApproved drafts={stuckApproved} busyId={busyRetryId} onRetry={fireRetry} />
              <NewDraftsBanner count={newCount} onDismiss={dismissNewDrafts} />
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {list.length === 0 ? (
              view === 'pending' ? (
                <EmptyState />
              ) : (
                <div className="flex h-40 items-center justify-center text-sm text-ink-dim">
                  No sent or rejected drafts yet
                </div>
              )
            ) : (
              <ul className="divide-y divide-border-subtle">
                {list.map((draft) => (
                  <li key={draft.id}>
                    <DraftCard
                      draft={draft}
                      isSelected={draft.id === selected?.id}
                      mode={view}
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
                  readOnly={view === 'sent'}
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

function FolderTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-2 px-3 py-2 font-sans text-xs font-medium transition-colors ${
        active
          ? 'border-b-2 border-b-accent-orange text-ink'
          : 'border-b-2 border-b-transparent text-ink-muted hover:text-ink'
      }`}
    >
      <span>{label}</span>
      <span className="rounded-full bg-bg-deep px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-ink-dim">
        {count}
      </span>
    </button>
  );
}
