import { getPool } from '@/lib/db';
import type { Persona } from '@/lib/types';

const GET_PERSONA_SQL = `
  SELECT * FROM mailbox.persona WHERE customer_key = $1
`;

const UPSERT_PERSONA_SQL = `
  INSERT INTO mailbox.persona
    (customer_key, statistical_markers, category_exemplars,
     source_email_count, last_refreshed_at, updated_at)
  VALUES ($1, $2, $3, $4, NOW(), NOW())
  ON CONFLICT (customer_key) DO UPDATE
    SET statistical_markers = EXCLUDED.statistical_markers,
        category_exemplars  = EXCLUDED.category_exemplars,
        source_email_count  = EXCLUDED.source_email_count,
        last_refreshed_at   = EXCLUDED.last_refreshed_at,
        updated_at          = NOW()
  RETURNING *
`;

export async function getPersona(
  customerKey = 'default',
): Promise<Persona | null> {
  const pool = getPool();
  const r = await pool.query<Persona>(GET_PERSONA_SQL, [customerKey]);
  return r.rows[0] ?? null;
}

export async function upsertPersona(
  statistical: Record<string, unknown>,
  exemplars: Record<string, unknown>,
  sourceCount: number,
  customerKey = 'default',
): Promise<Persona> {
  const pool = getPool();
  const r = await pool.query<Persona>(UPSERT_PERSONA_SQL, [
    customerKey,
    JSON.stringify(statistical),
    JSON.stringify(exemplars),
    sourceCount,
  ]);
  return r.rows[0];
}
