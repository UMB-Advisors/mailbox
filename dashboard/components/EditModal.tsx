'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { DraftWithMessage } from '@/lib/types';

const MAX_BODY = 10_000;

export function EditModal({
  draft,
  onSave,
  onClose,
}: {
  draft: DraftWithMessage;
  onSave: (body: string, subject: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [body, setBody] = useState(draft.draft_body);
  const [subject, setSubject] = useState(draft.draft_subject ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, saving]);

  const handleSave = async () => {
    if (!body.trim()) {
      setError('Body cannot be empty');
      return;
    }
    if (body.length > MAX_BODY) {
      setError(`Body exceeds ${MAX_BODY} characters`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(body, subject.trim() || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Edit draft"
    >
      <div className="flex w-full flex-col bg-bg-panel sm:max-w-2xl sm:rounded sm:border sm:border-border">
        <header className="flex items-center justify-between border-b border-border p-4">
          <h2 className="font-sans text-base font-semibold">Edit draft</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            <X size={20} />
          </button>
        </header>
        <div className="flex-1 space-y-3 overflow-auto p-4">
          <label className="block">
            <span className="mb-1 block font-mono text-xs text-ink-dim">
              Subject (optional)
            </span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={saving}
              className="w-full rounded border border-border bg-bg-deep px-3 py-2 font-sans text-sm focus:border-accent-blue focus:outline-none disabled:opacity-50"
            />
          </label>
          <label className="block">
            <span className="mb-1 flex items-center justify-between font-mono text-xs text-ink-dim">
              <span>Body</span>
              <span>
                {body.length} / {MAX_BODY}
              </span>
            </span>
            <textarea
              ref={textareaRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={saving}
              rows={14}
              className="w-full resize-y rounded border border-border bg-bg-deep p-3 font-serif text-base leading-relaxed focus:border-accent-blue focus:outline-none disabled:opacity-50"
            />
          </label>
          {error && <p className="text-sm text-accent-red">{error}</p>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border p-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded px-4 py-2 font-sans text-sm text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded bg-accent-blue px-4 py-2 font-sans text-sm font-semibold text-white transition-colors hover:bg-accent-blue/90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
