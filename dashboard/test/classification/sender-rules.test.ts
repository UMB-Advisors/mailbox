// Spec 002 FR7 (Stage 2b-1) — Train sender-rule lookup + apply precedence.
// Pure `senderRuleAction` + the `senderRule` safety envelope (kill switch,
// fail-open, exact-email-over-domain / force-over-bias precedence) against a
// mocked Kysely store — no Postgres.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.fn();
vi.mock('@/lib/db', () => ({
  getKysely: () => {
    const qb: Record<string, unknown> = {};
    qb.selectFrom = () => qb;
    qb.select = () => qb;
    qb.where = () => qb;
    qb.execute = execMock;
    return qb;
  },
}));
vi.mock('@/lib/queries-accounts', () => ({
  getDefaultAccountId: vi.fn(async () => 1),
}));

import {
  type SenderRuleHit,
  senderRule,
  senderRuleAction,
} from '@/lib/classification/sender-rules';

describe('senderRuleAction (pure precedence)', () => {
  it('null hit → none', () => {
    expect(senderRuleAction(null)).toEqual({ kind: 'none' });
  });
  it('force hit → hard route', () => {
    const hit: SenderRuleHit = {
      match: 'gemini-notes@google.com',
      kind: 'email',
      target_bucket: 'meeting_notes',
      mode: 'force',
    };
    expect(senderRuleAction(hit)).toEqual({ kind: 'force', category: 'meeting_notes' });
  });
  it('bias hit → a prior the classifier reconciles, not a bypass', () => {
    const hit: SenderRuleHit = {
      match: 'example.com',
      kind: 'domain',
      target_bucket: 'internal',
      mode: 'bias',
    };
    expect(senderRuleAction(hit)).toEqual({ kind: 'bias', prior: 'internal' });
  });
});

describe('senderRule (envelope: kill switch, fail-open, precedence)', () => {
  beforeEach(() => {
    execMock.mockReset();
    delete process.env.SENDER_RULES_DISABLE;
  });
  afterEach(() => {
    delete process.env.SENDER_RULES_DISABLE;
  });

  it('kill switch SENDER_RULES_DISABLE=1 short-circuits without a DB call', async () => {
    process.env.SENDER_RULES_DISABLE = '1';
    expect(await senderRule('a@b.com')).toBeNull();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('blank sender → null (no DB call)', async () => {
    expect(await senderRule(undefined)).toBeNull();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('exact-email force outranks a domain bias rule', async () => {
    execMock.mockResolvedValue([
      { match: 'google.com', kind: 'domain', target_bucket: 'internal', mode: 'bias' },
      {
        match: 'gemini-notes@google.com',
        kind: 'email',
        target_bucket: 'meeting_notes',
        mode: 'force',
      },
    ]);
    const hit = await senderRule('Gemini <gemini-notes@google.com>');
    expect(hit).toEqual({
      match: 'gemini-notes@google.com',
      kind: 'email',
      target_bucket: 'meeting_notes',
      mode: 'force',
    });
  });

  it('domain-kind rule matches the bare domain', async () => {
    execMock.mockResolvedValue([
      { match: 'gusto.com', kind: 'domain', target_bucket: 'notification', mode: 'force' },
    ]);
    const hit = await senderRule('payroll@gusto.com');
    expect(hit?.target_bucket).toBe('notification');
    expect(hit?.kind).toBe('domain');
  });

  it('fail-open: a DB error yields null (degrades to the normal classify path)', async () => {
    execMock.mockRejectedValue(new Error('pg down'));
    expect(await senderRule('a@b.com')).toBeNull();
  });

  it('rows whose kind does not match the value they matched on are ignored', async () => {
    // a domain-kind row whose match equals the full EMAIL (not the bare domain)
    // must not be treated as a hit.
    execMock.mockResolvedValue([
      { match: 'a@b.com', kind: 'domain', target_bucket: 'spam', mode: 'force' },
    ]);
    expect(await senderRule('a@b.com')).toBeNull();
  });
});
