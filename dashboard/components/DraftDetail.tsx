import type { DraftWithMessage } from '@/lib/types';
import { ActionButtons, type ActionKind } from './ActionButtons';
import { EmailContext } from './EmailContext';

export function DraftDetail({
  draft,
  busy,
  onApprove,
  onEdit,
  onReject,
}: {
  draft: DraftWithMessage;
  busy: ActionKind | null;
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
      <ActionButtons
        busy={busy}
        onApprove={onApprove}
        onEdit={onEdit}
        onReject={onReject}
      />
    </article>
  );
}
