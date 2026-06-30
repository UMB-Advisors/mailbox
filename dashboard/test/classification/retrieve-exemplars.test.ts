// Spec 002 FR7b (Stage 2b-2) — retrieveClassificationExemplars wrapper:
// fail-closed on DB error, respects the disable-via-cap=0 switch, and threads the
// senderPrior bias into the list query. The list helper is mocked (no DB).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listMock = vi.fn();
vi.mock('@/lib/queries-classification-exemplars', () => ({
  listClassificationExemplars: (...a: unknown[]) => listMock(...a),
}));

import { retrieveClassificationExemplars } from '@/lib/classification/exemplars';

beforeEach(() => {
  listMock.mockReset();
  delete process.env.CLASSIFY_FEWSHOT_CAP;
});
afterEach(() => {
  delete process.env.CLASSIFY_FEWSHOT_CAP;
});

const row = (snippet: string, bucket: string, created_at = '2026-06-30T00:00:00Z') => ({
  id: 1,
  snippet,
  bucket,
  company: null,
  source_msg_id: null,
  enabled: true,
  reason: null,
  created_by: 'operator',
  created_at,
});

describe('retrieveClassificationExemplars', () => {
  it('FAILS CLOSED to [] when the list query throws', async () => {
    listMock.mockRejectedValue(new Error('pg down'));
    const out = await retrieveClassificationExemplars({ subject: 'x' });
    expect(out).toEqual([]);
  });

  it('returns [] without a DB call when few-shot is disabled (cap=0)', async () => {
    process.env.CLASSIFY_FEWSHOT_CAP = '0';
    const out = await retrieveClassificationExemplars({ subject: 'x' });
    expect(out).toEqual([]);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('passes the senderPrior as preferBucket and over-fetches a window', async () => {
    listMock.mockResolvedValue([row('team note', 'internal')]);
    await retrieveClassificationExemplars({ senderPrior: 'internal', subject: 'hi', account_id: 4 });
    expect(listMock).toHaveBeenCalledTimes(1);
    const arg = listMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.preferBucket).toBe('internal');
    expect(arg.account_id).toBe(4);
    expect(arg.limit as number).toBeGreaterThanOrEqual(24);
  });

  it('selects + caps the fetched rows (maps to {snippet,bucket})', async () => {
    listMock.mockResolvedValue([row('a', 'receipt'), row('b', 'spam')]);
    const out = await retrieveClassificationExemplars({ subject: 'a' });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((e) => typeof e.snippet === 'string' && typeof e.bucket === 'string')).toBe(true);
  });
});
