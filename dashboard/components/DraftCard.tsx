'use client';

import { type DraftWithMessage, URGENCY_SIGNAL_LABELS, type UrgencySignal } from '@/lib/types';
import { FreshnessChip } from './FreshnessChip';
import { TimeAgo } from './TimeAgo';

// MBOX-134 signal → chip color. escalate is the loudest (red); the rest step
// down. Mirrors the URGENCY_SIGNALS display priority.
const SIGNAL_CHIP: Record<UrgencySignal, string> = {
  escalate: 'border-accent-red/40 bg-accent-red/10 text-accent-red',
  vip: 'border-accent-orange/40 bg-accent-orange/10 text-accent-orange',
  aged: 'border-accent-orange/30 bg-accent-orange/5 text-accent-orange',
  low_conf: 'border-ink-dim/30 bg-ink-dim/10 text-ink-muted',
};

// Outlook-style compact list row. Fixed h-14 so 30+ drafts fit in the
// left pane without overflow surprises. Detail pane shows the full body.
//
// `mode` controls whether the row reflects the inbound classification
// (pending view) or the outbound disposition (sent view).
export function DraftCard({
  draft,
  isSelected,
  mode = 'pending',
  showAccount = false,
  onSelect,
}: {
  draft: DraftWithMessage;
  isSelected: boolean;
  mode?: 'pending' | 'sent';
  // MBOX-162 V3 — render the owning-mailbox badge (the cross-account Priority
  // view). Off elsewhere so the single-account queue stays uncluttered.
  showAccount?: boolean;
  onSelect: () => void;
}) {
  const m = draft.message;
  const fromName =
    m.from_addr?.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim() || m.from_addr?.split('@')[0] || 'unknown';

  const accountLabel = draft.account?.display_label || draft.account?.email_address || null;
  const signals = draft.urgency?.signals ?? [];

  const indicator =
    mode === 'sent'
      ? sentIndicator(draft.status)
      : classificationIndicator(m.classification, m.confidence);

  // Sent view shows when the draft was finalized.
  const sentTimestamp = draft.sent_at ?? draft.updated_at ?? draft.created_at;

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
          <span className="min-w-0 truncate text-sm font-medium text-ink">{fromName}</span>
          {showAccount && accountLabel && (
            <span
              className="shrink-0 truncate rounded-sm border border-border bg-bg-deep px-1.5 py-0.5 font-mono text-[10px] text-ink-dim"
              title={draft.account?.email_address ?? accountLabel}
            >
              {accountLabel}
            </span>
          )}
          {/* STAQPRO-331 #8 — pending view uses the freshness chip keyed on
              drafts.created_at so the operator sees how long the draft has
              been waiting for approval (the actionable signal), with color
              advancing as it ages. Sent view keeps the relative-time
              timestamp since the row is read-only — color isn't actionable. */}
          <span className="ml-auto shrink-0 font-mono tabular-nums">
            {mode === 'sent' ? (
              <span className="font-mono text-[11px] text-ink-dim">
                <TimeAgo iso={sentTimestamp} />
              </span>
            ) : (
              <FreshnessChip iso={draft.created_at} />
            )}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <span className="min-w-0 truncate text-xs text-ink-muted">
            {m.subject || '(no subject)'}
          </span>
          {signals.length > 0 && (
            <span className="flex shrink-0 items-center gap-1">
              {signals.map((s) => (
                <span
                  key={s}
                  className={`rounded-sm border px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide ${SIGNAL_CHIP[s]}`}
                  title={URGENCY_SIGNAL_LABELS[s]}
                >
                  {URGENCY_SIGNAL_LABELS[s]}
                </span>
              ))}
            </span>
          )}
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
