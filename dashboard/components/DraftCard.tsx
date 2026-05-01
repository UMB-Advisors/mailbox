'use client';

import type { DraftWithMessage } from '@/lib/types';
import { TimeAgo } from './TimeAgo';

// Outlook-style compact list row. Fixed h-14 so 30+ drafts fit in the
// left pane without overflow surprises. Detail pane shows the full body.
//
// `mode` controls whether the row reflects the inbound classification
// (pending view) or the outbound disposition (sent view).
export function DraftCard({
  draft,
  isSelected,
  mode = 'pending',
  onSelect,
}: {
  draft: DraftWithMessage;
  isSelected: boolean;
  mode?: 'pending' | 'sent';
  onSelect: () => void;
}) {
  const m = draft.message;
  const fromName =
    m.from_addr?.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim() || m.from_addr?.split('@')[0] || 'unknown';

  const indicator =
    mode === 'sent'
      ? sentIndicator(draft.status)
      : classificationIndicator(m.classification, m.confidence);

  // Sent view shows when the draft was finalized; pending view shows when
  // the inbound email landed.
  const timestamp =
    mode === 'sent' ? (draft.sent_at ?? draft.updated_at ?? draft.created_at) : m.received_at;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={isSelected}
      className={`group flex h-14 w-full items-center gap-2 border-l-2 px-3 text-left transition-colors duration-100 ${
        isSelected
          ? 'border-l-accent-orange bg-bg-panel'
          : 'border-l-transparent hover:bg-bg-panel/60'
      }`}
    >
      <span
        className={`shrink-0 h-2 w-2 rounded-full ${indicator.dotColor}`}
        title={indicator.title}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-ink">{fromName}</span>
          <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-ink-dim">
            <TimeAgo iso={timestamp} />
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <span className="min-w-0 truncate text-xs text-ink-muted">
            {m.subject || '(no subject)'}
          </span>
          <span
            className={`ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wide ${indicator.labelColor}`}
          >
            {indicator.label}
          </span>
        </div>
      </div>
    </button>
  );
}

function classificationIndicator(classification: string | null, confidence: string | null) {
  const conf = confidence != null ? parseFloat(confidence) : null;
  const dotColor =
    conf == null
      ? 'bg-ink-dim'
      : conf >= 0.85
        ? 'bg-accent-green'
        : conf >= 0.6
          ? 'bg-accent-orange'
          : 'bg-accent-red';
  const label = classification ?? '—';
  return {
    dotColor,
    label,
    labelColor: 'text-ink-dim',
    title: `${label}${conf != null ? ` ${Math.round(conf * 100)}%` : ''}`,
  };
}

function sentIndicator(status: string) {
  switch (status) {
    case 'sent':
      return {
        dotColor: 'bg-accent-green',
        label: 'sent',
        labelColor: 'text-accent-green',
        title: 'Sent via Gmail',
      };
    case 'approved':
      return {
        dotColor: 'bg-accent-orange',
        label: 'sending',
        labelColor: 'text-accent-orange',
        title: 'Approved — n8n send in flight',
      };
    case 'rejected':
      return {
        dotColor: 'bg-accent-red',
        label: 'rejected',
        labelColor: 'text-accent-red',
        title: 'Rejected by operator',
      };
    default:
      return {
        dotColor: 'bg-ink-dim',
        label: status,
        labelColor: 'text-ink-dim',
        title: status,
      };
  }
}
