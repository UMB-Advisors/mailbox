import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeRequest } from '../helpers/db';

// n8n-wire (Spec 002 FR7/FR7b/FR4 reaching the LIVE pipeline) — tests for the
// two new independent steps `classification-normalize` now runs immediately
// before its final response: (a) a SECOND force/reverb precheck (resolve-
// preclass.ts, shared with classify-one.ts / classification-prompt) using the
// newly-optional `subject` field, and (b) escalation-promotion using the
// newly-optional `subject`+`body` fields. Everything DB-backed is mocked —
// no live Postgres, no live Ollama. `senderRule` is the only DB-backed
// dependency this route touches on these code paths (isNeverSpamSender /
// operatorOwnsThread are never invoked because none of these scenarios pass
// a thread_id or a spam_marketing verdict, so `couldSuppress` stays false).
vi.mock('@/lib/classification/sender-rules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/classification/sender-rules')>();
  return { ...actual, senderRule: vi.fn(async () => null) };
});

import { senderRule } from '@/lib/classification/sender-rules';

const mockedSenderRule = vi.mocked(senderRule);

describe('POST /api/internal/classification-normalize — n8n-wire additions', () => {
  afterEach(() => {
    mockedSenderRule.mockReset();
    mockedSenderRule.mockResolvedValue(null);
  });

  it('force-mode sender → meeting_notes regardless of a garbage raw LLM output', async () => {
    mockedSenderRule.mockResolvedValue({
      match: 'gemini-notes@google.com',
      kind: 'email',
      target_bucket: 'meeting_notes',
      mode: 'force',
    });
    const { POST } = await import('@/app/api/internal/classification-normalize/route');
    const res = await POST(
      fakeRequest({
        body: {
          raw: 'this is not json at all — garbage output',
          from: 'gemini-notes@google.com',
          to: 'op@example.com',
          subject: 'Notes: Weekly sync',
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.category).toBe('meeting_notes');
    expect(body.preclass_applied).toBe(true);
    expect(body.preclass_source).toBe('sender-rule-force');
    expect(body.confidence).toBe(1);
  });

  it('Reverb "Message about…" subject → sales_lead', async () => {
    const { POST } = await import('@/app/api/internal/classification-normalize/route');
    const res = await POST(
      fakeRequest({
        body: {
          raw: '{"category":"unknown","confidence":0.2}',
          from: 'messages@reverb.com',
          to: 'op@example.com',
          subject: 'Message about your Stratocaster',
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.category).toBe('sales_lead');
    expect(body.preclass_applied).toBe(true);
    expect(body.preclass_source).toBe('reverb-subject');
  });

  it('a notification matching an escalation_signal pattern → escalate', async () => {
    const { POST } = await import('@/app/api/internal/classification-normalize/route');
    const res = await POST(
      fakeRequest({
        body: {
          raw: '{"category":"notification","confidence":0.9}',
          from: 'billing@state-of-co.example.com',
          to: 'op@example.com',
          subject: 'Sales Tax Filing Deadline',
          body: 'Your quarterly sales tax filing is due next week.',
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.category).toBe('escalate');
    expect(body.escalation_signal).toBe('filing_or_tax_due');
    expect(body.important).toBe(true);
  });

  it('regression — a normal message with no force/reverb/escalation match is unchanged', async () => {
    const { POST } = await import('@/app/api/internal/classification-normalize/route');
    const res = await POST(
      fakeRequest({
        body: {
          raw: '{"category":"inquiry","confidence":0.88}',
          from: 'customer@example.com',
          to: 'op@example.com',
          subject: 'Question about my order',
          body: 'Hi, when will my order ship?',
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.category).toBe('inquiry');
    expect(body.confidence).toBe(0.88);
    expect(body.preclass_applied).toBe(false);
    expect(body.escalation_signal).toBeNull();
    expect(body.important).toBe(false);
  });

  it('backward compat — old callers omitting subject/body still work unchanged', async () => {
    const { POST } = await import('@/app/api/internal/classification-normalize/route');
    const res = await POST(
      fakeRequest({
        body: {
          raw: '{"category":"reorder","confidence":0.95}',
          from: 'customer@example.com',
          to: 'op@example.com',
          // subject / body intentionally omitted — pre-existing n8n contract.
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.category).toBe('reorder');
    expect(body.confidence).toBe(0.95);
    // escalation-promotion never ran (no subject/body) — field stays undefined/absent.
    expect(body.escalation_signal ?? null).toBeNull();
  });
});
