import { Check, Send, X } from 'lucide-react';
import type { DraftWithMessage } from '@/lib/types';
import { ActionButtons, type ActionKind } from './ActionButtons';
import { EmailContext } from './EmailContext';
import { TimeAgo } from './TimeAgo';

export function DraftDetail({
  draft,
  busy,
  readOnly = false,
  onApprove,
  onEdit,
  onReject,
}: {
  draft: DraftWithMessage;
  busy: ActionKind | null;
  readOnly?: boolean;
  onApprove: () => void;
  onEdit: () => void;
  onReject: () => void;
}) {
  return (
    <article className="rounded border border-border bg-bg-panel p-5">
      <EmailContext message={draft.message} />
      <div className="mt-5 border-t border-border pt-4">
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
        <p className="mt-4 font-mono text-xs text-ink-dim">
          {draft.model}
          {draft.input_tokens != null && draft.output_tokens != null && (
            <>
              {' · '}
              {draft.input_tokens}↗ / {draft.output_tokens}↙ tokens
            </>
          )}
        </p>
      </div>
      {readOnly ? (
        <StatusBanner draft={draft} />
      ) : (
        <ActionButtons busy={busy} onApprove={onApprove} onEdit={onEdit} onReject={onReject} />
      )}
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
      className={`mt-4 flex items-center gap-2 rounded border px-3 py-2 font-sans text-sm ${palette}`}
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
