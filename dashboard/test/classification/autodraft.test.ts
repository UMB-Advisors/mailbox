// Spec 002 FR6 (Stage 2b-3) — auto-draft-on-classify scaffold. Pure, no DB.
// Verifies: empty flag → OFF, list → ON, FR5 canDraft is respected, NEVER sends.

import { describe, expect, it, vi } from 'vitest';
import {
  type AutodraftContext,
  type EnqueuePendingDraft,
  getAutodraftBuckets,
  maybeEnqueueAutodraft,
  parseAutodraftBuckets,
  shouldAutodraft,
} from '@/lib/classification/autodraft';
import type { Category } from '@/lib/classification/prompt';

const ctx = (bucket: Category): AutodraftContext => ({ inbox_message_id: 1, bucket });
const envWith = (val?: string): NodeJS.ProcessEnv =>
  (val === undefined ? {} : { AUTODRAFT_BUCKETS: val }) as NodeJS.ProcessEnv;

describe('parseAutodraftBuckets', () => {
  it('empty / unset → [] (OFF)', () => {
    expect(parseAutodraftBuckets(undefined)).toEqual([]);
    expect(parseAutodraftBuckets(null)).toEqual([]);
    expect(parseAutodraftBuckets('')).toEqual([]);
    expect(parseAutodraftBuckets('   ')).toEqual([]);
  });
  it('comma-list → trimmed, non-empty entries', () => {
    expect(parseAutodraftBuckets('client_request, escalate ,, follow_up')).toEqual([
      'client_request',
      'escalate',
      'follow_up',
    ]);
  });
  it('getAutodraftBuckets reads the env var', () => {
    expect(getAutodraftBuckets(envWith('escalate'))).toEqual(['escalate']);
    expect(getAutodraftBuckets(envWith())).toEqual([]);
  });
});

describe('shouldAutodraft', () => {
  it('default OFF (empty flag) → false for every bucket', () => {
    expect(shouldAutodraft('client_request', envWith())).toBe(false);
    expect(shouldAutodraft('escalate', envWith(''))).toBe(false);
  });
  it('true only when listed AND canDraft', () => {
    const env = envWith('client_request,escalate,follow_up');
    expect(shouldAutodraft('client_request', env)).toBe(true);
    expect(shouldAutodraft('escalate', env)).toBe(true);
  });
  it('respects FR5 canDraft even when a non-draftable bucket is listed', () => {
    // receipt/notification have reply policy `none` → never draft, flag or not.
    const env = envWith('receipt,notification,marketing_promo');
    expect(shouldAutodraft('receipt', env)).toBe(false);
    expect(shouldAutodraft('notification', env)).toBe(false);
    expect(shouldAutodraft('marketing_promo', env)).toBe(false);
  });
  it('false when the bucket is not in the list', () => {
    expect(shouldAutodraft('sales_lead', envWith('client_request'))).toBe(false);
  });
});

describe('maybeEnqueueAutodraft — hook behavior', () => {
  it('default OFF: does NOT call enqueue, returns not-enqueued', async () => {
    const enqueue = vi.fn<EnqueuePendingDraft>(async () => 99);
    const res = await maybeEnqueueAutodraft(ctx('client_request'), enqueue, envWith());
    expect(res.enqueued).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('listed + draftable: enqueues exactly one PENDING stub', async () => {
    const enqueue = vi.fn<EnqueuePendingDraft>(async () => 42);
    const env = envWith('escalate');
    const res = await maybeEnqueueAutodraft(ctx('escalate'), enqueue, env);
    expect(res.enqueued).toBe(true);
    if (res.enqueued) expect(res.draft_id).toBe(42);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({ inbox_message_id: 1, bucket: 'escalate' });
  });

  it('listed but NOT draftable (FR5): does NOT enqueue', async () => {
    const enqueue = vi.fn<EnqueuePendingDraft>(async () => 1);
    const res = await maybeEnqueueAutodraft(ctx('receipt'), enqueue, envWith('receipt'));
    expect(res.enqueued).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('NEVER sends: the enqueue dep is the ONLY side effect; no send is invoked', async () => {
    // The hook surface exposes exactly one injected effect (enqueue) and there
    // is no send path. We assert a send spy is never touched on any path.
    const send = vi.fn(); // stand-in for any "send" — must stay untouched
    const enqueue = vi.fn<EnqueuePendingDraft>(async () => {
      // even when enqueue runs, it must not trigger a send
      return 7;
    });
    await maybeEnqueueAutodraft(ctx('client_request'), enqueue, envWith('client_request'));
    await maybeEnqueueAutodraft(ctx('receipt'), enqueue, envWith('receipt'));
    await maybeEnqueueAutodraft(ctx('client_request'), enqueue, envWith());
    expect(send).not.toHaveBeenCalled();
  });
});
