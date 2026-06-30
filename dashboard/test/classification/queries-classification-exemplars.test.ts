// Spec 002 FR7b (Stage 2b-2) — classifier exemplar write/read helpers against a
// mocked Kysely store (no Postgres). Mirrors the sender-rules envelope test
// style: assert the query shape (idempotent upsert target, account scope, soft
// disable) without a DB.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A chainable query-builder stub that records the calls we care about.
const calls = {
  table: '' as string,
  values: undefined as unknown,
  onConflict: false,
  set: undefined as unknown,
  wheres: [] as Array<[string, string, unknown]>,
  orderBys: [] as unknown[],
  limit: undefined as number | undefined,
};
const executeMock = vi.fn();
const executeTakeFirstOrThrowMock = vi.fn();

function makeQb(): Record<string, unknown> {
  const qb: Record<string, unknown> = {};
  qb.insertInto = (t: string) => {
    calls.table = t;
    return qb;
  };
  qb.selectFrom = (t: string) => {
    calls.table = t;
    return qb;
  };
  qb.updateTable = (t: string) => {
    calls.table = t;
    return qb;
  };
  qb.values = (v: unknown) => {
    calls.values = v;
    return qb;
  };
  qb.select = () => qb;
  qb.set = (v: unknown) => {
    calls.set = v;
    return qb;
  };
  qb.where = (a: string, b: string, c: unknown) => {
    calls.wheres.push([a, b, c]);
    return qb;
  };
  qb.orderBy = (a: unknown) => {
    calls.orderBys.push(a);
    return qb;
  };
  qb.limit = (n: number) => {
    calls.limit = n;
    return qb;
  };
  qb.onConflict = (fn: (oc: Record<string, unknown>) => unknown) => {
    calls.onConflict = true;
    const oc: Record<string, unknown> = {};
    oc.columns = () => oc;
    oc.where = () => oc;
    oc.doUpdateSet = () => oc;
    fn(oc);
    return qb;
  };
  qb.returning = () => qb;
  qb.execute = executeMock;
  qb.executeTakeFirstOrThrow = executeTakeFirstOrThrowMock;
  return qb;
}

vi.mock('@/lib/db', () => ({ getKysely: () => makeQb() }));
vi.mock('@/lib/queries-accounts', () => ({ getDefaultAccountId: vi.fn(async () => 1) }));

import {
  disableClassificationExemplar,
  listClassificationExemplars,
  upsertClassificationExemplar,
} from '@/lib/queries-classification-exemplars';

beforeEach(() => {
  calls.table = '';
  calls.values = undefined;
  calls.onConflict = false;
  calls.set = undefined;
  calls.wheres = [];
  calls.orderBys = [];
  calls.limit = undefined;
  executeMock.mockReset();
  executeTakeFirstOrThrowMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('upsertClassificationExemplar', () => {
  it('with source_msg_id → idempotent upsert (onConflict), default account, trims snippet', async () => {
    executeTakeFirstOrThrowMock.mockResolvedValue({ id: 42 });
    const id = await upsertClassificationExemplar({
      snippet: '  payout email  ',
      bucket: 'receipt',
      source_msg_id: 'msg-1',
    });
    expect(id).toBe(42);
    expect(calls.table).toBe('classification_exemplars');
    expect(calls.onConflict).toBe(true);
    const v = calls.values as Record<string, unknown>;
    expect(v.account_id).toBe(1);
    expect(v.snippet).toBe('payout email');
    expect(v.bucket).toBe('receipt');
    expect(v.source_msg_id).toBe('msg-1');
    expect(v.enabled).toBe(true);
  });

  it('without source_msg_id → plain insert (no onConflict)', async () => {
    executeTakeFirstOrThrowMock.mockResolvedValue({ id: 7 });
    await upsertClassificationExemplar({ snippet: 'hand-authored', bucket: 'spam' });
    expect(calls.onConflict).toBe(false);
    const v = calls.values as Record<string, unknown>;
    expect(v.source_msg_id).toBeNull();
  });

  it('passes an explicit account_id through', async () => {
    executeTakeFirstOrThrowMock.mockResolvedValue({ id: 1 });
    await upsertClassificationExemplar({
      snippet: 's',
      bucket: 'internal',
      source_msg_id: 'm',
      account_id: 9,
    });
    expect((calls.values as Record<string, unknown>).account_id).toBe(9);
  });
});

describe('listClassificationExemplars', () => {
  it('enabled-only by default, account-scoped, recent-first, with limit', async () => {
    executeMock.mockResolvedValue([]);
    await listClassificationExemplars({ limit: 24 });
    expect(calls.table).toBe('classification_exemplars');
    expect(calls.wheres).toContainEqual(['account_id', '=', 1]);
    expect(calls.wheres).toContainEqual(['enabled', '=', true]);
    expect(calls.limit).toBe(24);
    // created_at desc ordering always present
    expect(calls.orderBys).toContain('created_at');
  });

  it('includeDisabled drops the enabled filter; bucket adds a filter', async () => {
    executeMock.mockResolvedValue([]);
    await listClassificationExemplars({ includeDisabled: true, bucket: 'sales_lead' });
    expect(calls.wheres).not.toContainEqual(['enabled', '=', true]);
    expect(calls.wheres).toContainEqual(['bucket', '=', 'sales_lead']);
  });

  it('maps rows to typed shape', async () => {
    executeMock.mockResolvedValue([
      {
        id: 3,
        snippet: 's',
        bucket: 'receipt',
        company: null,
        source_msg_id: 'm',
        enabled: true,
        reason: null,
        created_by: 'operator',
        created_at: '2026-06-30T00:00:00Z',
      },
    ]);
    const rows = await listClassificationExemplars();
    expect(rows[0]).toMatchObject({ id: 3, bucket: 'receipt', source_msg_id: 'm' });
  });
});

describe('disableClassificationExemplar', () => {
  it('soft-disables by id within the account scope', async () => {
    executeMock.mockResolvedValue(undefined);
    await disableClassificationExemplar({ id: 5 });
    expect(calls.set).toEqual({ enabled: false });
    expect(calls.wheres).toContainEqual(['id', '=', 5]);
    expect(calls.wheres).toContainEqual(['account_id', '=', 1]);
  });
});
