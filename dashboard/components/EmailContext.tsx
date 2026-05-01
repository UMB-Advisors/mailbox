import { formatEmailBody } from '@/lib/format-body';
import type { InboxMessage } from '@/lib/types';

export function EmailContext({ message }: { message: InboxMessage }) {
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 font-mono text-xs">
        <Row label="From" value={message.from_addr} />
        <Row label="To" value={message.to_addr} />
        <Row label="Subject" value={message.subject} />
        {message.received_at && (
          <Row label="Received" value={formatTimestamp(message.received_at)} muted />
        )}
      </dl>
      {message.body && (
        <div className="rounded border border-border-subtle bg-bg-deep p-3">
          <pre className="whitespace-pre-wrap break-words font-serif text-sm leading-relaxed text-ink-muted">
            {formatEmailBody(message.body)}
          </pre>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: string | null;
  muted?: boolean;
}) {
  return (
    <>
      <dt className="text-ink-dim">{label}:</dt>
      <dd className={muted ? 'text-ink-muted' : 'text-ink'}>{value ?? '—'}</dd>
    </>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
