// dashboard/lib/queries-system-state.ts
//
// Singleton-row queries for mailbox.system_state — system-wide flags that
// don't fit on any individual row (drafts, inbox_messages, etc.). Currently
// just the Gmail rate-limit cooldown landed by STAQPRO-227 stretch; future
// system flags (RAG eval-disabled, classify-paused, etc.) will live here.

import { sql } from 'kysely';
import { getKysely } from '@/lib/db';

export interface GmailCooldown {
  until: Date | null;
  isActive: boolean;
}

export async function getGmailCooldown(): Promise<GmailCooldown> {
  const db = getKysely();
  const row = await sql<{ gmail_rate_limit_until: string | null }>`
    SELECT gmail_rate_limit_until FROM mailbox.system_state WHERE id = 1
  `.execute(db);
  const until = row.rows[0]?.gmail_rate_limit_until
    ? new Date(row.rows[0].gmail_rate_limit_until)
    : null;
  return {
    until,
    isActive: until !== null && until.getTime() > Date.now(),
  };
}

// Idempotent: only advances the cooldown forward — never retreats it. A
// sweeper that finds an older retry-after timestamp shouldn't shorten an
// active probation window. Useful when multiple n8n executions are 429'd
// near-simultaneously and the sweeper races to record the latest.
export async function setGmailCooldown(until: Date): Promise<void> {
  const db = getKysely();
  await sql`
    UPDATE mailbox.system_state
       SET gmail_rate_limit_until = GREATEST(gmail_rate_limit_until, ${until.toISOString()}::timestamptz),
           gmail_rate_limit_set_at = NOW()
     WHERE id = 1
  `.execute(db);
}
