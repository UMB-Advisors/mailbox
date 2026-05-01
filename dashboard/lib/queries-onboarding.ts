import { getPool } from '@/lib/db';
import type { Onboarding, OnboardingStage } from '@/lib/types';

const GET_ONBOARDING_SQL = `
  SELECT * FROM mailbox.onboarding WHERE customer_key = $1
`;

const UPDATE_ONBOARDING_STAGE_SQL = `
  UPDATE mailbox.onboarding
     SET stage = $2,
         lived_at = CASE WHEN $2 = 'live' THEN NOW() ELSE lived_at END
   WHERE customer_key = $1
   RETURNING *
`;

const UPDATE_ADMIN_SQL = `
  UPDATE mailbox.onboarding
     SET admin_username = $2,
         admin_password_hash = $3,
         stage = 'pending_email'
   WHERE customer_key = $1
   RETURNING *
`;

const UPDATE_EMAIL_SQL = `
  UPDATE mailbox.onboarding
     SET email_address = $2,
         stage = 'ingesting'
   WHERE customer_key = $1
   RETURNING *
`;

export async function getOnboarding(customerKey = 'default'): Promise<Onboarding | null> {
  const pool = getPool();
  const r = await pool.query<Onboarding>(GET_ONBOARDING_SQL, [customerKey]);
  return r.rows[0] ?? null;
}

export async function setStage(
  stage: OnboardingStage,
  customerKey = 'default',
): Promise<Onboarding | null> {
  const pool = getPool();
  const r = await pool.query<Onboarding>(UPDATE_ONBOARDING_STAGE_SQL, [customerKey, stage]);
  return r.rows[0] ?? null;
}

export async function setAdmin(
  username: string,
  passwordHash: string,
  customerKey = 'default',
): Promise<Onboarding | null> {
  const pool = getPool();
  const r = await pool.query<Onboarding>(UPDATE_ADMIN_SQL, [customerKey, username, passwordHash]);
  return r.rows[0] ?? null;
}

export async function setEmail(email: string, customerKey = 'default'): Promise<Onboarding | null> {
  const pool = getPool();
  const r = await pool.query<Onboarding>(UPDATE_EMAIL_SQL, [customerKey, email]);
  return r.rows[0] ?? null;
}

export async function isLive(customerKey = 'default'): Promise<boolean> {
  const row = await getOnboarding(customerKey);
  return row?.stage === 'live';
}
