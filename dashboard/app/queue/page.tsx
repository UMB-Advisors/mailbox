import { QueueClient } from '@/components/QueueClient';
import { listDrafts } from '@/lib/queries';
import type { DraftWithMessage } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function QueuePage() {
  let initialActive: DraftWithMessage[] = [];
  let initialFailed: DraftWithMessage[] = [];
  let error: string | null = null;

  try {
    [initialActive, initialFailed] = await Promise.all([
      listDrafts(['pending', 'edited'], 50),
      listDrafts(['failed'], 50),
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load drafts';
  }

  return (
    <main className="mx-auto min-h-screen max-w-7xl p-4 lg:p-6">
      {error ? (
        <>
          <header className="mb-6 flex items-center justify-between">
            <h1 className="font-sans text-xl font-semibold tracking-tight">MailBox One</h1>
          </header>
          <div className="rounded border border-accent-red/40 bg-accent-red/10 p-4 text-sm text-accent-red">
            <p className="mb-1 font-medium">Failed to load drafts</p>
            <p className="font-mono text-xs">{error}</p>
          </div>
        </>
      ) : (
        <QueueClient initialActive={initialActive} initialFailed={initialFailed} />
      )}
    </main>
  );
}
