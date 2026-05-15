import type { CooldownState } from '@/components/GmailCooldownBanner';
import { QueueClient } from '@/components/QueueClient';
import { listDrafts } from '@/lib/queries';
import { getGmailCooldown } from '@/lib/queries-system-state';
import type { DraftWithMessage } from '@/lib/types';

export const dynamic = 'force-dynamic';

const EMPTY_COOLDOWN: CooldownState = {
  is_active: false,
  until: null,
  set_at: null,
  recommended_safe_at: null,
};

export default async function QueuePage() {
  let initialActive: DraftWithMessage[] = [];
  let initialSent: DraftWithMessage[] = [];
  let initialCooldown: CooldownState = EMPTY_COOLDOWN;
  let error: string | null = null;

  try {
    const [active, sent, cooldown] = await Promise.all([
      listDrafts(['pending', 'edited'], 50),
      // "Sent" view aggregates approved + sent + rejected so operators can see
      // what they shipped (and what they killed). Approved is in-flight; sent
      // hit Gmail Reply; rejected was killed in the queue. Stuck-at-approved
      // (STAQPRO-202) is computed from this list client-side.
      listDrafts(['approved', 'sent', 'rejected'], 50),
      // STAQPRO-331 #5 — initial cooldown read for the banner. Client-side
      // polling refreshes it alongside the drafts list.
      getGmailCooldown(),
    ]);
    initialActive = active;
    initialSent = sent;
    initialCooldown = {
      is_active: cooldown.isActive,
      until: cooldown.until?.toISOString() ?? null,
      set_at: cooldown.set_at?.toISOString() ?? null,
      recommended_safe_at: cooldown.recommended_safe_at?.toISOString() ?? null,
    };
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load drafts';
  }

  if (error) {
    return (
      <main className="flex h-screen flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-border-subtle bg-bg-panel px-4">
          <h1 className="font-sans text-sm font-semibold tracking-tight">MailBox One</h1>
        </header>
        <div className="m-4 rounded-sm border border-accent-red/40 bg-accent-red/10 p-4 text-sm text-accent-red">
          <p className="mb-1 font-medium">Failed to load drafts</p>
          <p className="font-mono text-xs">{error}</p>
        </div>
      </main>
    );
  }

  return (
    <QueueClient
      initialActive={initialActive}
      initialSent={initialSent}
      initialCooldown={initialCooldown}
    />
  );
}
