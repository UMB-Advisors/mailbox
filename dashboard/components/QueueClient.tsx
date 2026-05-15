'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from '@/lib/api';
import { type DraftWithMessage, REJECT_REASON_LABELS } from '@/lib/types';
import type { ActionKind } from './ActionButtons';
import { AppShell } from './AppShell';
import { DraftCard } from './DraftCard';
import { DraftDetail } from './DraftDetail';
import { EditModal } from './EditModal';
import { EmptyState } from './EmptyState';
import { type CooldownState, GmailCooldownBanner } from './GmailCooldownBanner';
import { NewDraftsBanner } from './NewDraftsBanner';
import type { RejectPayload } from './RejectPopover';
import { ShortcutsHelp } from './ShortcutsHelp';
import { StuckApproved } from './StuckApproved';
import { Toast } from './Toast';

const POLL_INTERVAL_MS = 30_000;
const STUCK_APPROVED_THRESHOLD_MS = 5 * 60 * 1000;

type Busy = { draftId: number; kind: ActionKind | 'retry' } | null;
// STAQPRO-331 #9 — widened to carry an optional action (Undo button) and a
// per-message duration override (Undo lingers 5s vs the 4s default).
type ToastMsg = {
  kind: 'success' | 'error';
  text: string;
  action?: { label: string; onClick: () => void };
  durationMs?: number;
} | null;
// STAQPRO-382 Phase 2a-2 (2026-05-15) — folder-driven queue. `folder` comes
// from `app/queue/page.tsx` which reads the URL ?folder= search param.
// `mode` is derived from folder and replaces the previous `view: 'pending' |
// 'sent'` internal state. The Sidebar (left rail) handles folder switching;
// the inline Inbox/Sent tab nav is gone.
type FolderKey = 'queue' | 'approved' | 'sent' | 'rejected' | 'all';
type Mode = 'active' | 'archive';

function modeForFolder(folder: FolderKey): Mode {
  // 'queue' and 'all' include pending+edited drafts that are still
  // actionable. The others show already-actioned drafts.
  return folder === 'queue' || folder === 'all' ? 'active' : 'archive';
}

interface Props {
  folder: FolderKey;
  initialList: DraftWithMessage[];
  initialStuck: DraftWithMessage[];
  initialCooldown: CooldownState;
}

export function QueueClient({ folder, initialList, initialStuck, initialCooldown }: Props) {
  const mode = modeForFolder(folder);
  const [drafts, setDrafts] = useState(initialList);
  const [stuckApproved, setStuckApproved] = useState(initialStuck);
  // STAQPRO-331 #5 — system-wide Gmail rate-limit cooldown. SSR-seeded so
  // the banner appears on first paint; refreshed every POLL_INTERVAL_MS
  // alongside the drafts list.
  const [cooldown, setCooldown] = useState<CooldownState>(initialCooldown);
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<Busy>(null);
  const [editing, setEditing] = useState<DraftWithMessage | null>(null);
  const [toast, setToast] = useState<ToastMsg>(null);
  const [newCount, setNewCount] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(
    initialList.length > 0 ? initialList[0].id : null,
  );
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  // STAQPRO-331 #1 — controlled popover state so the 'x' keyboard shortcut
  // can open it without reaching into DraftDetail's DOM.
  const [rejectPopoverOpen, setRejectPopoverOpen] = useState(false);
  // STAQPRO-331 #7 — '?' toggles a keyboard-shortcut cheatsheet overlay.
  // Discoverability for the operator who didn't read the docs.
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  // STAQPRO-331 #8 — pending-queue sort order. 'newest' is the default
  // (matches the listDrafts ORDER BY created_at DESC server-side sort);
  // 'oldest' surfaces stale/overdue drafts at the top.
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');

  const knownIds = useRef<Set<number>>(new Set(initialList.map((d) => d.id)));

  // Status slice per folder — mirrors the server's statusesForFolder() in
  // app/queue/page.tsx. Kept in sync by hand; the wire shape is the same.
  const statusQuery = (() => {
    switch (folder) {
      case 'queue':
        return 'pending,edited';
      case 'approved':
        return 'approved';
      case 'sent':
        return 'sent';
      case 'rejected':
        return 'rejected';
      case 'all':
        return 'pending,edited,approved,sent,rejected';
    }
  })();

  const wantsStuck = folder === 'queue';

  const fetchData = useCallback(
    async (silent: boolean) => {
      try {
        const [listRes, stuckRes, cooldownRes] = await Promise.all([
          fetch(apiUrl(`/api/drafts?status=${statusQuery}&limit=50`), { cache: 'no-store' }),
          // Stuck-approved banner only needs refreshing on the queue folder;
          // skip the round trip otherwise.
          wantsStuck
            ? fetch(apiUrl('/api/drafts?status=approved&limit=50'), { cache: 'no-store' })
            : Promise.resolve(null),
          // STAQPRO-331 #5 — Gmail cooldown refresh. Don't gate the whole
          // fetchData on it; if the cooldown route errors, drafts still
          // update. Cooldown is best-effort UI signal.
          fetch(apiUrl('/api/system/gmail-cooldown'), { cache: 'no-store' }),
        ]);
        if (!listRes.ok) return;
        const listJson = await listRes.json();
        const nextList: DraftWithMessage[] = listJson.drafts ?? [];

        if (silent) {
          for (const d of nextList) knownIds.current.add(d.id);
        } else if (mode === 'active') {
          const fresh = nextList.map((d) => d.id).filter((id) => !knownIds.current.has(id));
          if (fresh.length > 0) {
            setNewCount((c) => c + fresh.length);
            for (const id of fresh) knownIds.current.add(id);
          }
        }

        setDrafts(nextList);

        if (wantsStuck && stuckRes?.ok) {
          const stuckJson = await stuckRes.json();
          setStuckApproved(stuckJson.drafts ?? []);
        }

        if (cooldownRes.ok) {
          const cooldownJson = (await cooldownRes.json()) as CooldownState;
          setCooldown(cooldownJson);
        }
      } catch {
        // Background poll — swallow transient errors.
      }
    },
    [statusQuery, wantsStuck, mode],
  );

  // STAQPRO-331 #11 — visibility-aware polling. Skip ticks when the tab is
  // hidden (no point spending battery + n8n CPU when nobody is watching) and
  // fire an immediate refetch on visibility return so an operator coming
  // back from another tab sees the queue caught up without waiting for the
  // next 30s tick. AbortController per-fetch is intentionally deferred —
  // fetchData uses two parallel cache:'no-store' fetches without
  // cancellation, and the last-write-wins setActive/setSent pattern is
  // already idempotent under in-flight overlap.
  useEffect(() => {
    function tick() {
      if (document.visibilityState !== 'visible') return;
      fetchData(false);
    }
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    function onVisibility() {
      if (document.visibilityState === 'visible') fetchData(false);
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchData]);

  const dismissToast = () => setToast(null);
  const dismissNewDrafts = () => setNewCount(0);

  // STAQPRO-331 #1 — fireAction now takes an optional `body` so reject can
  // ship the structured `{ reason_code, free_text }` payload while approve
  // keeps its empty-body shape. Auto-advance + toast logic stays shared.
  async function fireAction(kind: 'approve' | 'reject', draft: DraftWithMessage, body?: object) {
    setBusy({ draftId: draft.id, kind });
    try {
      const res = await fetch(apiUrl(`/api/drafts/${draft.id}/${kind}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
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
      const oldVisible = mode === 'active' ? drafts.filter((d) => !removed.has(d.id)) : drafts;
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

  // STAQPRO-331 #9 — reject success path now surfaces an UNDO toast carrying
  // the reason label. Implemented inline (not via fireAction) so the toast
  // can hold a reference to the just-rejected draft id without racing the
  // auto-advance state update. Approve stays on fireAction with no UNDO —
  // approve fires a Gmail Reply at the n8n side and is not safely reversible
  // once the webhook returns.
  async function fireReject(payload: RejectPayload, draft: DraftWithMessage) {
    setBusy({ draftId: draft.id, kind: 'reject' });
    try {
      const res = await fetch(apiUrl(`/api/drafts/${draft.id}/reject`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `reject failed (${res.status})`);

      setRemoved((s) => {
        const next = new Set(s);
        next.add(draft.id);
        return next;
      });
      // Auto-advance to the next visible draft (matches fireAction).
      const oldVisible = mode === 'active' ? drafts.filter((d) => !removed.has(d.id)) : drafts;
      const idx = oldVisible.findIndex((d) => d.id === draft.id);
      const newVisible = oldVisible.filter((_, i) => i !== idx);
      const next = newVisible[idx] ?? newVisible[idx - 1] ?? null;
      setSelectedId(next?.id ?? null);

      const reasonLabel = REJECT_REASON_LABELS[payload.reason_code];
      setToast({
        kind: 'success',
        text: `Rejected · ${reasonLabel}`,
        durationMs: 5000,
        action: {
          label: 'Undo',
          onClick: () => fireUndoReject(draft.id),
        },
      });
      fetchData(true);
    } catch (err) {
      setToast({
        kind: 'error',
        text: err instanceof Error ? err.message : 'reject failed',
      });
    } finally {
      setBusy(null);
    }
  }

  // STAQPRO-331 #9 — undo a reject within the 5s toast window. Drops the
  // local `removed` mark so the draft reappears in visibleActive once
  // fetchData repopulates it. 409 = window expired or already-undone; surface
  // as an error toast and bail without local state surgery.
  async function fireUndoReject(draftId: number) {
    try {
      const res = await fetch(apiUrl(`/api/drafts/${draftId}/undo-reject`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setToast({
          kind: 'error',
          text: data?.error ?? `Undo failed (${res.status})`,
        });
        return;
      }
      setRemoved((s) => {
        const next = new Set(s);
        next.delete(draftId);
        return next;
      });
      setToast({ kind: 'success', text: 'Reject undone' });
      fetchData(true);
    } catch (err) {
      setToast({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Undo failed',
      });
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

  // STAQPRO-331 #8 — apply pending-queue sort. Server returns newest-first
  // (created_at DESC); 'oldest' flips it so overdue rows surface at the top.
  // Archive folders (approved/sent/rejected) stay in server order — there's
  // no actionable "oldest first" mental model for already-finalized rows.
  const visibleList = (() => {
    if (mode !== 'active') return drafts;
    const filtered = drafts.filter((d) => !removed.has(d.id));
    if (sortOrder !== 'oldest') return filtered;
    return [...filtered].sort((a, b) => {
      const at = new Date(a.created_at).getTime();
      const bt = new Date(b.created_at).getTime();
      return at - bt;
    });
  })();
  // STAQPRO-202 — drafts stuck at status='approved' beyond the webhook
  // timeout window. Sole operator recovery surface for send-side failures
  // (the 'failed' status was retired in migration 016 — see CLAUDE.md
  // Conventions > Draft status state machine). The stuckApproved state was
  // fetched separately by the server for the queue folder only; we apply
  // the staleness threshold here to filter to actually-stuck rows.
  const stuckApprovedFiltered = stuckApproved.filter((d) => {
    if (d.status !== 'approved') return false;
    const updated = d.updated_at ? new Date(d.updated_at).getTime() : NaN;
    if (!Number.isFinite(updated)) return false;
    return Date.now() - updated > STUCK_APPROVED_THRESHOLD_MS;
  });
  const selected = visibleList.find((d) => d.id === selectedId) ?? visibleList[0] ?? null;
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
      // STAQPRO-331 #7 — Escape closes the help overlay even when the
      // popover is also open; let the help close first so the operator
      // can re-orient before the popover steals focus.
      if (e.key === 'Escape' && shortcutsHelpOpen) {
        e.preventDefault();
        setShortcutsHelpOpen(false);
        return;
      }
      // When the reject popover is open, swallow nav/action keys —
      // RejectPopover owns Escape itself.
      if (rejectPopoverOpen) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // STAQPRO-331 #7 — '?' (Shift+/) toggles the shortcuts cheatsheet.
      // No selection / view guard — the overlay should always be available.
      if (e.key === '?') {
        e.preventDefault();
        setShortcutsHelpOpen((o) => !o);
        return;
      }

      const currentIndex =
        selectedId == null ? -1 : visibleList.findIndex((d) => d.id === selectedId);

      switch (e.key) {
        case 'j':
        case 'ArrowDown': {
          e.preventDefault();
          const nextDraft = visibleList[currentIndex + 1];
          if (nextDraft) setSelectedId(nextDraft.id);
          return;
        }
        case 'k':
        case 'ArrowUp': {
          e.preventDefault();
          const prevDraft = visibleList[currentIndex - 1];
          if (prevDraft) setSelectedId(prevDraft.id);
          return;
        }
        // STAQPRO-331 #7 — Enter is now an explicit approve alias per
        // the sandbox action-bar hint. The popover swallows Enter when
        // open (we guard above on rejectPopoverOpen).
        case 'Enter':
        case 'a': {
          if (!selected || mode === 'archive' || busy) return;
          e.preventDefault();
          fireAction('approve', selected);
          return;
        }
        case 'e': {
          if (!selected || mode === 'archive' || busy) return;
          e.preventDefault();
          setEditing(selected);
          return;
        }
        // STAQPRO-331 #7 — `r` is an alias for `x` (reject-popover open).
        // The original 'NOT r' constraint targeted Cmd+R refresh muscle-
        // memory; the modifier-key bail above means a plain `r` is a
        // deliberate keystroke, and the popover still requires the
        // operator to pick a reason and click Reject (no auto-fire).
        case 'r':
        case 'x': {
          if (!selected || mode === 'archive' || busy) return;
          e.preventDefault();
          setRejectPopoverOpen(true);
          return;
        }
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

  // Folder-specific count label for the header chip. Each folder name
  // matches the rail entry so the operator gets matching language.
  const countLabel = (() => {
    switch (folder) {
      case 'queue':
        return 'pending';
      case 'approved':
        return 'approved';
      case 'sent':
        return 'sent';
      case 'rejected':
        return 'rejected';
      case 'all':
        return 'drafts';
    }
  })();

  return (
    <AppShell active={{ kind: 'folder', folder }}>
      {/* Top bar — wordmark/AppNav moved into the left rail (Sidebar) per
          STAQPRO-382 Phase 2a. Folder-aware count + stuck count + shortcuts
          hint stay as page-local chrome. The inline Inbox/Sent FolderTab
          nav was retired in Phase 2a-2 — the rail handles folder switching. */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-panel px-4">
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-border bg-bg-deep px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink-muted">
            {visibleList.length} {countLabel}
          </span>
          {folder === 'queue' && stuckApprovedFiltered.length > 0 && (
            <span className="rounded-full border border-accent-orange/40 bg-accent-orange/10 px-2 py-0.5 font-mono text-[11px] tabular-nums text-accent-orange">
              {stuckApprovedFiltered.length} stuck
            </span>
          )}
        </div>
        {/* STAQPRO-331 #7 — discovery hint for the keyboard shortcut help.
            Clicking also opens the overlay so it's not exclusively keyboard. */}
        <button
          type="button"
          onClick={() => setShortcutsHelpOpen(true)}
          className="flex items-center gap-1.5 rounded-sm border border-border bg-bg-deep px-2 py-0.5 font-mono text-[11px] text-ink-dim hover:text-ink"
          title="Show keyboard shortcuts"
        >
          <kbd className="font-mono text-[11px]">?</kbd>
          <span>shortcuts</span>
        </button>
      </header>

      {/* STAQPRO-331 #5 — system-wide Gmail cooldown banner. Spans the
          full width above both panes so the operator sees it whether
          they're in Inbox or Sent view. Self-hides when not active. */}
      {cooldown.is_active && (
        <div className="border-b border-border-subtle bg-bg-panel px-4 py-2">
          <GmailCooldownBanner cooldown={cooldown} />
        </div>
      )}

      {/* Two-pane body */}
      <div className="flex min-h-0 flex-1">
        {/* Left list pane */}
        <aside
          className={`flex w-full shrink-0 flex-col border-r border-border-subtle md:w-80 ${
            mobileDetailOpen ? 'hidden md:flex' : 'flex'
          }`}
        >
          {/* STAQPRO-331 #8 — sort selector (active folder only). Lets the
              operator flip to oldest-first so overdue rows surface at the
              top of the list. Hidden in archive folders (no actionable
              "oldest first" mental model for already-finalized rows). */}
          {mode === 'active' && visibleList.length > 1 && (
            <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border-subtle bg-bg-panel px-3 py-1.5 font-mono text-[11px] text-ink-dim">
              <span>Sort</span>
              <button
                type="button"
                onClick={() => setSortOrder('newest')}
                className={
                  sortOrder === 'newest'
                    ? 'text-ink underline underline-offset-2'
                    : 'text-ink-muted hover:text-ink'
                }
              >
                newest
              </button>
              <span aria-hidden>·</span>
              <button
                type="button"
                onClick={() => setSortOrder('oldest')}
                className={
                  sortOrder === 'oldest'
                    ? 'text-ink underline underline-offset-2'
                    : 'text-ink-muted hover:text-ink'
                }
              >
                oldest
              </button>
            </div>
          )}

          {mode === 'active' && (stuckApprovedFiltered.length > 0 || newCount > 0) && (
            <div className="space-y-2 border-b border-border-subtle p-2">
              <StuckApproved
                drafts={stuckApprovedFiltered}
                busyId={busyRetryId}
                onRetry={fireRetry}
                cooldownActive={cooldown.is_active}
                cooldownSafeAt={cooldown.recommended_safe_at}
              />
              <NewDraftsBanner count={newCount} onDismiss={dismissNewDrafts} />
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {visibleList.length === 0 ? (
              mode === 'active' ? (
                <EmptyState />
              ) : (
                <div className="flex h-40 items-center justify-center text-sm text-ink-dim">
                  No {folder} drafts yet
                </div>
              )
            ) : (
              <ul className="divide-y divide-border-subtle">
                {visibleList.map((draft) => (
                  <li key={draft.id}>
                    <DraftCard
                      draft={draft}
                      isSelected={draft.id === selected?.id}
                      mode={mode === 'active' ? 'pending' : 'sent'}
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
                  readOnly={mode === 'archive'}
                  onApprove={() => fireAction('approve', selected)}
                  onEdit={() => setEditing(selected)}
                  onReject={(payload) => fireReject(payload, selected)}
                  rejectPopoverOpen={rejectPopoverOpen}
                  onRejectPopoverChange={setRejectPopoverOpen}
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
      {shortcutsHelpOpen && <ShortcutsHelp onClose={() => setShortcutsHelpOpen(false)} />}
      {toast && <Toast {...toast} onDismiss={dismissToast} />}
    </AppShell>
  );
}
