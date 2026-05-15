import { Check, Send, X } from 'lucide-react';
import type { DraftWithMessage } from '@/lib/types';
import { ActionButtons, type ActionKind } from './ActionButtons';
import { EditDiff } from './EditDiff';
import { EmailContext } from './EmailContext';
import type { RejectPayload } from './RejectPopover';
import { RoutingBadge } from './RoutingBadge';
import { SenderHistoryPanel } from './SenderHistoryPanel';
import { SourcesUsedPanel } from './SourcesUsedPanel';
import { TimeAgo } from './TimeAgo';

export function DraftDetail({
  draft,
  busy,
  readOnly = false,
  onApprove,
  onEdit,
  onReject,
  rejectPopoverOpen,
  onRejectPopoverChange,
}: {
  draft: DraftWithMessage;
  busy: ActionKind | null;
  readOnly?: boolean;
  onApprove: () => void;
  onEdit: () => void;
  // STAQPRO-331 #1 — reject now carries structured feedback.
  onReject: (payload: RejectPayload) => void;
  // Optional controlled-popover hooks from QueueClient (lets the 'x'
  // keyboard shortcut open the popover instead of firing reject directly).
  rejectPopoverOpen?: boolean;
  onRejectPopoverChange?: (open: boolean) => void;
}) {
  return (
    // STAQPRO-148-followup (Delphi UX pass) — restructured top-to-bottom so
    // operator never scrolls to reach the primary action: actions → draft →
    // inbound (collapsed). Old order pushed actions below the inbound body
    // which often overflowed the viewport.
    <article className="flex flex-col rounded-sm border border-border bg-bg-panel">
      <div className="border-b border-border px-5 py-3">
        {readOnly ? (
          <StatusBanner draft={draft} />
        ) : (
          <ActionButtons
            busy={busy}
            onApprove={onApprove}
            onEdit={onEdit}
            onReject={onReject}
            rejectPopoverOpen={rejectPopoverOpen}
            onRejectPopoverChange={onRejectPopoverChange}
          />
        )}
      </div>
      <div className="px-5 py-4">
        <p className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-ink-dim">
          <span>Draft reply</span>
          {draft.status === 'edited' && (
            <span className="rounded-full border border-accent-blue/40 bg-accent-blue/10 px-2 py-0.5 normal-case tracking-normal text-accent-blue">
              edited
            </span>
          )}
        </p>
        {draft.draft_subject && (
          <p className="mb-3 font-mono text-sm text-ink-muted">
            <span className="text-ink-dim">Subject: </span>
            {draft.draft_subject}
          </p>
        )}
        <pre className="whitespace-pre-wrap font-serif text-base leading-relaxed text-ink">
          {draft.draft_body}
        </pre>
        {/* STAQPRO-331 #3 — RoutingBadge surfaces local-vs-cloud + model +
            classifier confidence + a "low confidence fallback" tag when the
            cloud route was a safety-net rather than a category match. The
            old plain-text model line is dropped — the badge covers it. */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <RoutingBadge
            draftSource={draft.draft_source}
            model={draft.model}
            classification={draft.message.classification}
            confidence={draft.message.confidence}
          />
          {draft.input_tokens != null && draft.output_tokens != null && (
            <span className="font-mono text-xs text-ink-dim">
              {draft.input_tokens}↗ / {draft.output_tokens}↙ tokens
            </span>
          )}
        </div>
        {/* STAQPRO-331 #4 — show changes between the LLM-original body and
            the operator-edited current body. Only mounts when the draft is
            in 'edited' status AND original_draft_body was captured by
            STAQPRO-121 (NULL means this draft was never edited). EditDiff
            itself is also defensive — returns null on no-op diffs — so the
            outer guard is a fast-path, not a correctness gate. */}
        {draft.status === 'edited' && draft.original_draft_body && (
          <div className="mt-3">
            <EditDiff original={draft.original_draft_body} current={draft.draft_body} />
          </div>
        )}
        {/* STAQPRO-331 #2 — RAG attribution panel. Lazy-loads the
            rag_context_refs resolution on first expand. `key={draft.id}`
            forces a remount when the operator switches drafts so all local
            state (open / cached data) resets without an explicit effect. */}
        <div className="mt-3">
          <SourcesUsedPanel key={draft.id} draftId={draft.id} />
        </div>
        {/* STAQPRO-331 #6 — per-sender acceptance stats over 30 days. Same
            key={draft.id} remount trick so switching drafts resets the
            lazy-fetch state without an explicit effect. */}
        <div className="mt-2">
          <SenderHistoryPanel key={draft.id} draftId={draft.id} />
        </div>
      </div>
      <div className="border-t border-border px-5 py-3">
        <EmailContext message={draft.message} history={draft.thread_history} />
      </div>
    </article>
  );
}

function StatusBanner({ draft }: { draft: DraftWithMessage }) {
  // Sent view replaces the action bar with a read-only status banner so the
  // operator can see WHAT happened and WHEN without re-firing it.
  switch (draft.status) {
    case 'sent':
      return (
        <Banner
          tone="green"
          icon={<Check size={16} />}
          label="Sent"
          timestamp={draft.sent_at ?? draft.updated_at}
        />
      );
    case 'approved':
      return (
        <Banner
          tone="orange"
          icon={<Send size={16} />}
          label="Approved — sending…"
          timestamp={draft.updated_at}
        />
      );
    case 'rejected':
      return (
        <Banner tone="red" icon={<X size={16} />} label="Rejected" timestamp={draft.updated_at} />
      );
    default:
      return <Banner tone="dim" icon={null} label={draft.status} timestamp={draft.updated_at} />;
  }
}

function Banner({
  tone,
  icon,
  label,
  timestamp,
}: {
  tone: 'green' | 'orange' | 'red' | 'dim';
  icon: React.ReactNode;
  label: string;
  timestamp: string | null;
}) {
  const palette = {
    green: 'border-accent-green/40 bg-accent-green/10 text-accent-green',
    orange: 'border-accent-orange/40 bg-accent-orange/10 text-accent-orange',
    red: 'border-accent-red/40 bg-accent-red/10 text-accent-red',
    dim: 'border-border bg-bg-deep text-ink-muted',
  }[tone];
  return (
    <div
      className={`flex items-center gap-2 rounded-sm border px-3 py-2 font-sans text-sm ${palette}`}
    >
      {icon}
      <span className="font-medium">{label}</span>
      {timestamp && (
        <span className="ml-auto font-mono text-xs opacity-75">
          <TimeAgo iso={timestamp} />
        </span>
      )}
    </div>
  );
}
