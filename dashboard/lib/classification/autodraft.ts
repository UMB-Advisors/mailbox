// Spec 002 FR6 (Stage 2b-3) — auto-draft-on-classify scaffold. OFF by default.
//
// WHY: FR6 makes drafting ON-DEMAND-FOR-ALL initially — NO bucket auto-drafts.
// Auto-draft is a deferred opt-in toggle (default OFF). This module is the
// plumbing for that toggle: an enqueue-on-classify hook gated by the
// `AUTODRAFT_BUCKETS` setting. With the flag empty (the default) the hook
// short-circuits before any enqueue, so behavior is unchanged today — the
// plumbing just exists for the operator to flip on later (the prior hybrid set was
// client_request / escalate / follow_up).
//
// SAFETY (FR6): MUST NEVER send. The enqueue produces a PENDING draft stub via
// the existing NATIVE pipeline (the same INSERT inbox_respond.py performs —
// NOT n8n). `auto_send_audit` must not change. There is no send path in this
// module; the enqueue dependency is the ONLY side effect and it is injected so
// the decision logic stays pure and unit-testable.

import { canDraft } from '@/lib/classification/draft-policy';
import type { Category } from '@/lib/classification/prompt';

// The setting flag (comma-list of bucket keys). Empty / unset = OFF.
export const AUTODRAFT_BUCKETS_ENV = 'AUTODRAFT_BUCKETS';

// Parse the comma-list flag. Empty / unset / whitespace-only → [] → OFF.
export function parseAutodraftBuckets(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Read the configured auto-draft buckets from the environment. Default OFF.
export function getAutodraftBuckets(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseAutodraftBuckets(env[AUTODRAFT_BUCKETS_ENV]);
}

// A classified bucket auto-drafts iff ALL hold:
//   1. the flag is non-empty (default OFF → false),
//   2. the bucket is listed, AND
//   3. canDraft(bucket) — FR5 gating ALWAYS applies, even when listed.
// So a non-reply-worthy bucket can never auto-draft no matter the flag value.
export function shouldAutodraft(
  bucket: Category,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const list = getAutodraftBuckets(env);
  if (list.length === 0) return false; // default OFF — zero auto-drafting
  if (!list.includes(bucket)) return false;
  return canDraft(bucket); // FR5 gate still applies
}

// Context the enqueue needs to create the pending stub for a classified message.
export interface AutodraftContext {
  inbox_message_id: number;
  bucket: Category;
}

// The enqueue dependency: creates a PENDING draft stub via the existing native
// pipeline (status='pending', empty body — the same row inbox_respond.py
// inserts) and returns its draft id. It MUST NEVER send and MUST NOT write
// auto_send_audit. Injected so this module stays pure; the appliance supplies
// the concrete implementation when the operator enables AUTODRAFT_BUCKETS.
export type EnqueuePendingDraft = (ctx: AutodraftContext) => Promise<number>;

export type AutodraftDecision =
  | { enqueued: true; draft_id: number; bucket: Category }
  | { enqueued: false; bucket: Category; reason: string };

// The enqueue-on-classify hook. Wire one call into the native classify path
// (after a row is classified) to enable auto-draft once a real
// EnqueuePendingDraft is supplied. Default-OFF: when AUTODRAFT_BUCKETS is empty
// it returns BEFORE calling `enqueue`, so nothing is created and there is zero
// behavior change. Never sends.
export async function maybeEnqueueAutodraft(
  ctx: AutodraftContext,
  enqueue: EnqueuePendingDraft,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AutodraftDecision> {
  if (!shouldAutodraft(ctx.bucket, env)) {
    return {
      enqueued: false,
      bucket: ctx.bucket,
      reason: 'autodraft disabled or bucket not eligible (default OFF)',
    };
  }
  // Pending stub only — NEVER sends, NEVER touches auto_send_audit.
  const draft_id = await enqueue(ctx);
  return { enqueued: true, draft_id, bucket: ctx.bucket };
}
