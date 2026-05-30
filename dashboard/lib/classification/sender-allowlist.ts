// MBOX-370 — per-sender never-spam allowlist (the "reclassify automatically" rule).
//
// When the operator picks "reclassify automatically" for a sender on
// /classifications, a row is upserted into mailbox.sender_never_spam (email).
// This is NOT a force-to-category rule (that was MBOX-368, reverted by migration
// 042) — it only means "never let this sender be dropped as spam." The classifier
// still decides the real category per email; we only override a spam_marketing
// verdict so a sender the operator cares about is never silently dropped again.
//
// Two consult points share this module:
//   1. app/api/internal/classification-normalize/route.ts (live n8n classify) —
//      async lookup, only when the verdict is a spam drop.
//   2. lib/queries-sender-allowlist.ts:reclassifyBySender (re-run on existing
//      mail) — the sender is allowlisted by construction, so it applies the
//      override directly without a second lookup.
//
// Exact-email match, normalized via extractAddress (same as the heuristic
// preclass). Kill switch SENDER_NEVER_SPAM_DISABLE=1.

import { getKysely } from '@/lib/db';
import { extractAddress } from './preclass';
import { type Category, type Route, routeFor } from './prompt';

// What an allowlisted spam verdict is rewritten to. 'unknown' is a CLOUD
// category → routeFor sends it to cloud → it surfaces as a draft for the
// operator instead of being dropped. The model still picks a real non-spam
// category for non-spam mail; this only catches the spam-drop case.
export const NEVER_SPAM_SURFACED_CATEGORY: Category = 'unknown';

function neverSpamEnabled(): boolean {
  return process.env.SENDER_NEVER_SPAM_DISABLE !== '1';
}

/**
 * True when a `spam_marketing` verdict came from the model or the noreply
 * heuristic (the cases a never-spam sender should override), and NOT from a
 * deliberate thread-level suppression (self-loop / owns-thread), which are
 * about the conversation, not the sender being junk.
 */
export function isHeuristicSpamDrop(category: Category, preclassSource: string | null): boolean {
  return (
    category === 'spam_marketing' &&
    preclassSource !== 'operator-self-loop' &&
    preclassSource !== 'operator-owns-thread'
  );
}

export interface NeverSpamSurface {
  category: Category;
  route: Route;
  preclass_source: 'sender-never-spam';
}

/** The category/route/source a surfaced (un-dropped) verdict takes. */
export function neverSpamSurface(confidence: number): NeverSpamSurface {
  return {
    category: NEVER_SPAM_SURFACED_CATEGORY,
    route: routeFor(NEVER_SPAM_SURFACED_CATEGORY, confidence),
    preclass_source: 'sender-never-spam',
  };
}

/**
 * Is this sender on the never-spam allowlist? Single indexed lookup on the
 * exact (lowercased) address. Fail-open: any DB error is swallowed and treated
 * as "not allowlisted" so a transient Postgres hiccup degrades to the normal
 * classify path rather than mis-surfacing.
 */
export async function isNeverSpamSender(rawFrom: string | undefined): Promise<boolean> {
  if (!neverSpamEnabled()) return false;

  const email = extractAddress(rawFrom);
  if (!email) return false;

  try {
    const row = await getKysely()
      .selectFrom('sender_never_spam')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();
    return Boolean(row);
  } catch (error) {
    console.error(`[never-spam] lookup failed for ${email} — failing open:`, error);
    return false;
  }
}
