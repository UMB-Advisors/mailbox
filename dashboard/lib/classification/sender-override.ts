// MBOX-368 — operator sender-level classification override (the "sticky rule").
//
// When the operator reclassifies a sender from /classifications, a row is
// upserted into mailbox.sender_classification_overrides (email → category). The
// classify pipeline consults this table at HIGHEST precedence in
// app/api/internal/classification-normalize/route.ts — before the LLM verdict
// AND before every heuristic preclass (noreply / self-loop / operator-domain)
// and the async owns-thread guard. An explicit operator decision is
// authoritative, so all FUTURE inbound from that address is forced to the
// chosen category without re-running the model.
//
// Exact-email match only (operator decision 2026-05-29) — the address is
// extracted + lowercased via the same extractAddress() the heuristic preclass
// uses, so "Name <Joe@Acme.com>" and "joe@acme.com" resolve identically.
//
// Kill switch: SENDER_OVERRIDE_PRECLASS_DISABLE=1 mirrors
// NOREPLY_PRECLASS_DISABLE / OPERATOR_SELF_LOOP_DISABLE — short-circuits the
// lookup (returns null) so the heuristic/LLM path runs unmodified.

import { getKysely } from '@/lib/db';
import { extractAddress } from './preclass';
import type { Category } from './prompt';

export interface SenderOverrideHit {
  category: Category;
  reason: string | null;
}

function senderOverrideEnabled(): boolean {
  return process.env.SENDER_OVERRIDE_PRECLASS_DISABLE !== '1';
}

/**
 * Look up an operator sender-override for the given raw `from` header. Returns
 * the forced category (+ the operator's reason note) when a row exists for the
 * extracted address, else null. Single indexed lookup on the unique `email`
 * column — cheap enough to run on every classify.
 *
 * Fail-open: any DB error is swallowed and treated as "no override" so a
 * transient Postgres hiccup degrades to the normal classify path rather than
 * dark-classifying the inbox.
 */
export async function getSenderOverride(
  rawFrom: string | undefined,
): Promise<SenderOverrideHit | null> {
  if (!senderOverrideEnabled()) return null;

  const email = extractAddress(rawFrom);
  if (!email) return null;

  try {
    const row = await getKysely()
      .selectFrom('sender_classification_overrides')
      .select(['category', 'reason'])
      .where('email', '=', email)
      .executeTakeFirst();
    if (!row) return null;
    return { category: row.category as Category, reason: row.reason };
  } catch (error) {
    console.error(`[sender-override] lookup failed for ${email} — failing open:`, error);
    return null;
  }
}
