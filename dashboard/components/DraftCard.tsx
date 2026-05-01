'use client';

import type { DraftWithMessage } from '@/lib/types';
import { TimeAgo } from './TimeAgo';

// Outlook-style compact list row. Fixed h-14 so 30+ drafts fit in the
// left pane without overflow surprises. Detail pane shows the full body.
export function DraftCard({
  draft,
  isSelected,
  onSelect,
}: {
  draft: DraftWithMessage;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const m = draft.message;
  const conf = m.confidence != null ? parseFloat(m.confidence) : null;
  const dotColor =
    conf == null
      ? 'bg-ink-dim'
      : conf >= 0.85
        ? 'bg-accent-green'
        : conf >= 0.6
          ? 'bg-accent-orange'
          : 'bg-accent-red';

  const classLabel = m.classification ?? '—';
  const fromName =
    m.from_addr?.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim() || m.from_addr?.split('@')[0] || 'unknown';

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
        className={`shrink-0 h-2 w-2 rounded-full ${dotColor}`}
        title={`${classLabel}${conf != null ? ` ${Math.round(conf * 100)}%` : ''}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-ink">{fromName}</span>
          <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-ink-dim">
            <TimeAgo iso={m.received_at} />
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <span className="min-w-0 truncate text-xs text-ink-muted">
            {m.subject || '(no subject)'}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wide text-ink-dim">
            {classLabel}
          </span>
        </div>
      </div>
    </button>
  );
}
