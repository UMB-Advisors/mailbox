import { sql } from 'kysely';
import { getKysely } from '@/lib/db';
import type { Persona } from '@/lib/types';

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
