import { Pool, types } from 'pg';

// pg returns TIMESTAMPTZ/TIMESTAMP as Date; we want strings to match wire format + our types.
types.setTypeParser(1184, (val: string) => val);
types.setTypeParser(1114, (val: string) => val);

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.POSTGRES_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error('Postgres pool error:', err);
    });
  }
  return pool;
}

// Llama 3.3-70B occasionally emits literal `\n` instead of newlines (BL-21).
export function normalizeDraftBody(body: string | null | undefined): string {
  if (!body) return '';
  return body.replace(/\\n/g, '\n');
}
