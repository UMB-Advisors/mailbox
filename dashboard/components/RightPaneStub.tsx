'use client';

import { Calendar, FolderOpen, X } from 'lucide-react';

// P1b (MBOX-162) — collapsible right-pane stub. The sandbox port plan
// (docs/plan-sandbox-ui-port.v0.1.0.md §4) ships the third pane as an empty
// collapsible placeholder in P1b; the Calendar/Drive iframes + operator
// settings storage land in P4. Kept as its own component so P4 can swap the
// body without touching QueueClient's layout wiring.
export function RightPaneStub({ onClose }: { onClose: () => void }) {
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-bg-deep">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-panel px-3">
        <div className="flex items-center gap-3 font-mono text-[11px] text-ink-muted">
          <span className="flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5" aria-hidden />
            Calendar
          </span>
          <span className="flex items-center gap-1.5">
            <FolderOpen className="h-3.5 w-3.5" aria-hidden />
            Drive
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm p-1 text-ink-dim hover:bg-bg-deep hover:text-ink"
          title="Hide right pane"
          aria-label="Hide right pane"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <Calendar className="h-8 w-8 text-ink-dim" aria-hidden />
        <p className="text-sm text-ink-muted">Calendar &amp; Drive</p>
        <p className="max-w-[18rem] text-xs text-ink-dim">
          Embedded calendar and Drive folder land here in P4, once operator settings storage is
          wired.
        </p>
      </div>
    </section>
  );
}
