'use client';

import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useEffect } from 'react';

export function Toast({
  kind,
  text,
  onDismiss,
}: {
  kind: 'success' | 'error';
  text: string;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const timeout = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timeout);
  }, [onDismiss]);

  const Icon = kind === 'success' ? CheckCircle2 : AlertCircle;
  const palette =
    kind === 'success'
      ? 'border-accent-green/40 bg-accent-green/10 text-accent-green'
      : 'border-accent-red/40 bg-accent-red/10 text-accent-red';

  return (
    <div
      role="status"
      className={`fixed bottom-4 left-4 right-4 z-50 inline-flex items-start gap-2 rounded border px-3 py-2 font-sans text-sm shadow-lg sm:left-auto sm:max-w-md ${palette}`}
    >
      <Icon size={16} className="mt-0.5 shrink-0" />
      <span className="break-words">{text}</span>
    </div>
  );
}
