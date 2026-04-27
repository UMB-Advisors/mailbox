'use client';

import { Check, Edit3, X } from 'lucide-react';

export type ActionKind = 'approve' | 'edit' | 'reject';

export function ActionButtons({
  busy,
  onApprove,
  onEdit,
  onReject,
}: {
  busy: ActionKind | null;
  onApprove: () => void;
  onEdit: () => void;
  onReject: () => void;
}) {
  const disabled = busy !== null;
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <button
        type="button"
        onClick={onApprove}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded bg-accent-orange px-4 py-2 font-sans text-sm font-semibold text-bg-deep transition-colors hover:bg-accent-orange/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Check size={16} />
        {busy === 'approve' ? 'Approving…' : 'Approve'}
      </button>
      <button
        type="button"
        onClick={onEdit}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded border border-accent-blue/60 bg-accent-blue/10 px-3 py-2 font-sans text-sm text-accent-blue transition-colors hover:bg-accent-blue/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Edit3 size={16} />
        {busy === 'edit' ? 'Saving…' : 'Edit'}
      </button>
      <button
        type="button"
        onClick={onReject}
        disabled={disabled}
        className="ml-auto inline-flex items-center gap-1.5 rounded border border-accent-red/40 px-3 py-2 font-sans text-sm text-accent-red/80 transition-colors hover:border-accent-red/70 hover:text-accent-red disabled:cursor-not-allowed disabled:opacity-50"
      >
        <X size={16} />
        {busy === 'reject' ? 'Rejecting…' : 'Reject'}
      </button>
    </div>
  );
}
