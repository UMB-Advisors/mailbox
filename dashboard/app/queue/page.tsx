import type { CooldownState } from '@/components/GmailCooldownBanner';
import { QueueClient } from '@/components/QueueClient';
import { listDrafts } from '@/lib/queries';
import { getGmailCooldown } from '@/lib/queries-system-state';
import type { DraftStatus, DraftWithMessage } from '@/lib/types';

export const dynamic = 'force-dynamic';

const EMPTY_COOLDOWN: CooldownState = {
  is_active: false,
  until: null,
  set_at: null,
  recommended_safe_at: null,
};

// Folder keys come from the left rail (components/Sidebar.tsx). Each folder
// maps to a different `mailbox.drafts.status` slice. STAQPRO-382 Phase 2a-2
// (2026-05-15) wires the URL ?folder= search param into the server fetch so
// each rail click drops to the right list.
type FolderKey = 'queue' | 'approved' | 'sent' | 'rejected' | 'all';

const VALID_FOLDERS: FolderKey[] = ['queue', 'approved', 'sent', 'rejected', 'all'];

function parseFolder(raw: string | string[] | undefined): FolderKey {
  if (Array.isArray(raw)) return parseFolder(raw[0]);
  if (raw && (VALID_FOLDERS as readonly string[]).includes(raw)) return raw as FolderKey;
  return 'queue';
}

// Status slice per folder. 'queue' shows the operator action list
// (pending + edited). 'all' aggregates every actionable status — useful for
// a single-pane view across the board.
function statusesForFolder(folder: FolderKey): DraftStatus[] {
  switch (folder) {
    case 'queue':
      return ['pending', 'edited'];
    case 'approved':
      return ['approved'];
    case 'sent':
      return ['sent'];
    case 'rejected':
      return ['rejected'];
    case 'all':
      return ['pending', 'edited', 'approved', 'sent', 'rejected'];
  }
}

interface QueuePageProps {
  searchParams?: { folder?: string | string[] };
}

export default async function QueuePage({ searchParams }: QueuePageProps) {
  const folder = parseFolder(searchParams?.folder);

  // The queue folder still needs the approved-list separately to power the
  // StuckApproved banner — approved drafts that errored on Gmail Reply leave
  // the row at status='approved' (STAQPRO-202 / STAQPRO-271). Other folders
  // don't render that banner.
  const wantsStuck = folder === 'queue';
  let initialList: DraftWithMessage[] = [];
  let initialStuck: DraftWithMessage[] = [];
  let initialCooldown: CooldownState = EMPTY_COOLDOWN;
  let error: string | null = null;

  try {
    const [list, stuck, cooldown] = await Promise.all([
      listDrafts(statusesForFolder(folder), 50),
      wantsStuck ? listDrafts(['approved'], 50) : Promise.resolve([] as DraftWithMessage[]),
      // STAQPRO-331 #5 — initial cooldown read for the banner. Client-side
      // polling refreshes it alongside the drafts list.
      getGmailCooldown(),
    ]);
    initialList = list;
    initialStuck = stuck;
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
      folder={folder}
      initialList={initialList}
      initialStuck={initialStuck}
      initialCooldown={initialCooldown}
    />
  );
}
