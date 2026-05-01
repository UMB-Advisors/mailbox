'use client';

import { AlertCircle, ChevronDown, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type { DraftWithMessage } from '@/lib/types';
import { TimeAgo } from './TimeAgo';

export function FailedSends({
  drafts,
  busyId,
  onRetry,
}: {
  drafts: DraftWithMessage[];
  busyId: number | null;
  onRetry: (draft: DraftWithMessage) => void;
}) {
  const [open, setOpen] = useState(true);

  if (drafts.length === 0) return null;

  return (
    <section className="mb-4 rounded border border-accent-red/40 bg-accent-red/5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 p-3 font-sans text-sm font-medium text-accent-red"
      >
        <AlertCircle size={16} />
        <span>
          {drafts.length} failed send{drafts.length === 1 ? '' : 's'}
        </span>
        <ChevronDown
          size={16}
          className={`ml-auto transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <ul className="divide-y divide-accent-red/20 border-t border-accent-red/20">
          {drafts.map((draft) => (
            <li key={draft.id} className="p-3">
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <p className="truncate font-mono text-xs text-ink-muted">
                  {draft.message.from_addr ?? 'unknown'}
                </p>
                <p className="font-mono text-xs text-ink-dim">
                  <TimeAgo iso={draft.updated_at} />
                </p>
              </div>
              <p className="mb-2 truncate font-sans text-sm font-medium">
                {draft.message.subject ?? '(no subject)'}
              </p>
              {draft.error_message && (
                <p className="mb-3 break-words font-mono text-xs text-accent-red">
                  {draft.error_message}
                </p>
              )}
              <button
                type="button"
                onClick={() => onRetry(draft)}
                disabled={busyId === draft.id}
                className="inline-flex items-center gap-1.5 rounded border border-accent-red/40 px-3 py-1.5 font-sans text-xs text-accent-red transition-colors hover:bg-accent-red/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw size={12} />
                {busyId === draft.id ? 'Retrying…' : 'Retry'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
