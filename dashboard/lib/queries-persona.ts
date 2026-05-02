import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import type { ExtractInput } from '@/lib/persona/extract';
import type { Persona } from '@/lib/types';

const DEFAULT_EXTRACTION_LIMIT = 200;

// STAQPRO-153: pull the last N sent_history rows for persona extraction.
// Joined to inbox_messages to grab the prompting subject/body so exemplars
// have the inbound side of each pair. Newest-first; cap at 500 to keep the
// extraction cost bounded on the Jetson.
export async function listSentHistoryForExtraction(
  limit = DEFAULT_EXTRACTION_LIMIT,
): Promise<ExtractInput[]> {
  const safe = Math.min(Math.max(Math.trunc(limit) || DEFAULT_EXTRACTION_LIMIT, 1), 500);
  const db = getKysely();
  const rows = await db
    .selectFrom('sent_history as s')
    .leftJoin('inbox_messages as m', 's.inbox_message_id', 'm.id')
    .select([
      's.draft_sent as draft_sent',
      's.classification_category as classification_category',
      'm.subject as inbox_subject',
      'm.body as inbox_body',
      's.sent_at as sent_at',
    ])
    .orderBy('s.sent_at', 'desc')
    .limit(safe)
    .execute();
  return rows.map((r) => ({
    draft_sent: r.draft_sent,
    classification_category: r.classification_category,
    inbox_subject: r.inbox_subject,
    inbox_body: r.inbox_body,
    sent_at: r.sent_at,
  }));
}

export async function getPersona(customerKey = 'default'): Promise<Persona | null> {
  const db = getKysely();
  const row = await db
    .selectFrom('persona')
    .selectAll()
    .where('customer_key', '=', customerKey)
    .executeTakeFirst();
  return (row as Persona | undefined) ?? null;
}

export async function upsertPersona(
  statistical: Record<string, unknown>,
  exemplars: Record<string, unknown>,
  sourceCount: number,
  customerKey = 'default',
): Promise<Persona> {
  const db = getKysely();
  // pg accepts a JS object as a JSON/JSONB parameter and stringifies internally;
  // the JSON.stringify calls preserve the original behavior verbatim.
  const stat = JSON.stringify(statistical);
  const exem = JSON.stringify(exemplars);
  const row = await db
    .insertInto('persona')
    .values({
      customer_key: customerKey,
      statistical_markers: sql`${stat}::jsonb`,
      category_exemplars: sql`${exem}::jsonb`,
      source_email_count: sourceCount,
      last_refreshed_at: sql<string>`NOW()`,
      updated_at: sql<string>`NOW()`,
    })
    .onConflict((oc) =>
      oc.column('customer_key').doUpdateSet((eb) => ({
        statistical_markers: eb.ref('excluded.statistical_markers'),
        category_exemplars: eb.ref('excluded.category_exemplars'),
        source_email_count: eb.ref('excluded.source_email_count'),
        last_refreshed_at: eb.ref('excluded.last_refreshed_at'),
        updated_at: sql<string>`NOW()`,
      })),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as Persona;
}
