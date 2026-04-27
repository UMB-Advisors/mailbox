'use client';

import type { DraftWithMessage } from '@/lib/types';
import { ChevronRight } from 'lucide-react';
import { ClassificationChip } from './ClassificationChip';
import { TimeAgo } from './TimeAgo';

export function DraftCard({
  draft,
  isSelected,
  onToggle,
}: {
  draft: DraftWithMessage;
  isSelected: boolean;
  onToggle: () => void;
}) {
  const m = draft.message;
  const previewLine =
    draft.draft_body.split('\n').find((l) => l.trim().length > 0) ?? '';

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isSelected}
      className={`block w-full rounded border bg-bg-panel p-4 text-left transition-colors ${
        isSelected
          ? 'border-accent-orange/60 bg-accent-orange/[0.06]'
          : 'border-border hover:border-ink-dim'
      }`}
    >
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <p className="truncate font-mono text-xs text-ink-muted">
          {m.from_addr ?? 'unknown sender'}
        </p>
        <div className="flex shrink-0 items-center gap-2 font-mono text-xs text-ink-dim">
          <TimeAgo iso={m.received_at} />
          <ChevronRight
            size={14}
            className={`transition-transform ${isSelected ? 'rotate-90' : ''}`}
          />
        </div>
      </div>
      <p className="mb-2 truncate font-sans text-base font-medium">
        {m.subject ?? '(no subject)'}
      </p>
      <p className="mb-2 line-clamp-2 text-sm text-ink-muted">{previewLine}</p>
      <ClassificationChip
        classification={m.classification}
        confidence={m.confidence}
      />
    </button>
  );
}
