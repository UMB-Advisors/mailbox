import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestPool, fakeRequest, getTestPool, HAS_DB } from '../helpers/db';

// STAQPRO-149: persona settings route tests. Default `customer_key='default'`
// is seeded by migration 006-create-onboarding-and-seed; tests assume that row
// exists and patch it back to a known empty state in afterAll.

const dbDescribe = HAS_DB ? describe : describe.skip;

dbDescribe('persona route handlers — real Postgres', () => {
  beforeAll(async () => {
    // CI bootstraps the schema from a pg_dump -s snapshot (no rows). Seed the
    // default persona row idempotently. Local dev DBs that already have the
    // row from migration 006 see a no-op upsert.
    const pool = getTestPool();
    await pool.query(
      `INSERT INTO mailbox.persona
         (customer_key, statistical_markers, category_exemplars, source_email_count)
       VALUES ('default', '{}'::jsonb, '{}'::jsonb, 0)
       ON CONFLICT (customer_key) DO UPDATE
         SET statistical_markers = '{}'::jsonb,
             category_exemplars = '{}'::jsonb,
             updated_at = NOW()`,
    );
  });

  afterAll(async () => {
    const pool = getTestPool();
    await pool.query(
      `UPDATE mailbox.persona
         SET statistical_markers = '{}'::jsonb,
             category_exemplars = '{}'::jsonb
       WHERE customer_key = 'default'`,
    );
    await closeTestPool();
  });

  it('GET returns default persona row', async () => {
    const { GET } = await import('@/app/api/persona/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { persona: { customer_key: string } | null };
    expect(body.persona?.customer_key).toBe('default');
  });

  it('PUT validates the request body', async () => {
    const { PUT } = await import('@/app/api/persona/route');
    const res = await PUT(
      fakeRequest({ body: { statistical_markers: 'not an object', category_exemplars: {} } }),
    );
    expect(res.status).toBe(400);
  });

  it('PUT upserts persona JSON fields', async () => {
    const { PUT } = await import('@/app/api/persona/route');
    const stat = { tone: 'concise', avg_sentence_words: 14 };
    const exem = { reorder: { example: 'sample reply' } };
    const res = await PUT(
      fakeRequest({ body: { statistical_markers: stat, category_exemplars: exem } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      persona: { statistical_markers: typeof stat; category_exemplars: typeof exem };
    };
    expect(body.persona.statistical_markers).toEqual(stat);
    expect(body.persona.category_exemplars).toEqual(exem);

    // Verify it actually wrote to the DB
    const pool = getTestPool();
    const r = await pool.query<{
      statistical_markers: typeof stat;
      category_exemplars: typeof exem;
    }>(
      `SELECT statistical_markers, category_exemplars FROM mailbox.persona WHERE customer_key = 'default'`,
    );
    expect(r.rows[0].statistical_markers).toEqual(stat);
    expect(r.rows[0].category_exemplars).toEqual(exem);
  });
});
