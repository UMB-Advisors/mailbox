import { describe, expect, it, vi } from 'vitest';
import {
  aggregate,
  buildReport,
  buildSampleSql,
  cosineSimilarity,
  generateDraft,
  type PairRow,
  type PerPairScore,
  parseArgs,
  scorePair,
} from '@/scripts/rag-eval-harness';

// STAQPRO-198 — harness unit tests. Focus is the pure math + SQL builder +
// JSON report shape, plus a thin scorePair contract test with mocks. The
// live Postgres / Ollama / Qdrant integration is run on the appliance per
// docs/runbook/rag-eval.v0.1.0.md — never as part of `npm test`.

describe('cosineSimilarity — STAQPRO-198', () => {
  it('returns 1 for identical unit vectors', () => {
    const v = [1, 0, 0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
  });

  it('returns -1 for antiparallel vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10);
  });

  it('returns 0 on length mismatch (defensive — never NaN)', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it('returns 0 on zero-magnitude inputs', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('matches the dot-product shortcut on unit-normalized inputs', () => {
    // Hand-normalized golden pair — nomic-style 768-dim vectors are
    // unit-normalized, so dot product equals cosine. We assert that holds
    // here so any future "optimize to dot-product-only" refactor can be
    // verified against this case.
    const a = [0.6, 0.8, 0]; // |a| = 1
    const b = [0.6, 0, 0.8]; // |b| = 1
    const cos = cosineSimilarity(a, b);
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(cos).toBeCloseTo(dot, 10);
    expect(cos).toBeCloseTo(0.36, 10);
  });
});

describe('aggregate — STAQPRO-198', () => {
  it('returns zeros on empty input', () => {
    expect(aggregate([])).toEqual({
      count: 0,
      mean: 0,
      median: 0,
      p25: 0,
      p75: 0,
      min: 0,
      max: 0,
    });
  });

  it('computes correct mean / median / quartiles on a known set', () => {
    const xs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    const a = aggregate(xs);
    expect(a.count).toBe(9);
    expect(a.mean).toBeCloseTo(0.5, 10);
    expect(a.median).toBeCloseTo(0.5, 10);
    expect(a.min).toBeCloseTo(0.1, 10);
    expect(a.max).toBeCloseTo(0.9, 10);
    // p25 / p75 — linear interpolation (R-7 / Excel default).
    // Index = 0.25 * 8 = 2 → xs[2] = 0.3 exactly.
    expect(a.p25).toBeCloseTo(0.3, 10);
    expect(a.p75).toBeCloseTo(0.7, 10);
  });

  it('drops non-finite values (NaN / Infinity) defensively', () => {
    const a = aggregate([0.5, Number.NaN, 0.7, Number.POSITIVE_INFINITY]);
    expect(a.count).toBe(2);
    expect(a.mean).toBeCloseTo(0.6, 10);
  });
});

describe('buildSampleSql — STAQPRO-198', () => {
  it('joins sent_history → inbox_messages on the foreign key (not header chase)', () => {
    const sql = buildSampleSql(null);
    expect(sql).toMatch(/JOIN mailbox\.inbox_messages im ON im\.id = sh\.inbox_message_id/);
  });

  it("filters to source = 'backfill' rows only", () => {
    expect(buildSampleSql(null)).toContain("sh.source = 'backfill'");
  });

  it('drops pairs with empty bodies on either side', () => {
    const sql = buildSampleSql(null);
    expect(sql).toContain("COALESCE(sh.draft_sent, '') <> ''");
    expect(sql).toContain("COALESCE(im.body, '') <> ''");
  });

  it('omits LIMIT when limit is null (--limit all)', () => {
    expect(buildSampleSql(null)).not.toMatch(/LIMIT\s+\d/);
  });

  it('appends LIMIT N when caller passes a positive integer', () => {
    expect(buildSampleSql(50)).toMatch(/LIMIT 50/);
  });

  it('floors fractional limits and clamps to >= 1', () => {
    expect(buildSampleSql(50.7)).toMatch(/LIMIT 50/);
    expect(buildSampleSql(0)).toMatch(/LIMIT 1/);
  });

  it('orders by sent_at ASC for stable run-prefix selection', () => {
    expect(buildSampleSql(10)).toMatch(/ORDER BY sh\.sent_at ASC/);
  });
});

describe('parseArgs — STAQPRO-198', () => {
  it("defaults to limit='all' when no flag passed", () => {
    expect(parseArgs([])).toEqual({ limit: 'all' });
  });

  it('accepts --limit all as an explicit choice', () => {
    expect(parseArgs(['--limit', 'all'])).toEqual({ limit: 'all' });
  });

  it('parses --limit N as an integer', () => {
    expect(parseArgs(['--limit', '50'])).toEqual({ limit: 50 });
  });

  it('rejects non-positive or non-numeric --limit values', () => {
    expect(() => parseArgs(['--limit', '0'])).toThrow();
    expect(() => parseArgs(['--limit', 'abc'])).toThrow();
    expect(() => parseArgs(['--limit', '-5'])).toThrow();
  });

  it('rejects --limit with no value', () => {
    expect(() => parseArgs(['--limit'])).toThrow();
  });
});

describe('buildReport — STAQPRO-198', () => {
  const baseScore = (overrides: Partial<PerPairScore>): PerPairScore => ({
    sent_history_id: 1,
    inbox_message_id: 'm1',
    classification: 'inquiry',
    cosine: 0.5,
    rag_refs_count: 0,
    rag_reason: 'no_hits',
    draft_chars: 100,
    actual_chars: 120,
    status: 'ok',
    ...overrides,
  });

  it('produces a stable JSON-serializable shape', () => {
    const report = buildReport({
      mode: 'with-rag',
      drafter_model: 'qwen3:4b-ctx4k',
      embed_model: 'nomic-embed-text:v1.5',
      sample_size_requested: 'all',
      per_pair: [
        baseScore({ sent_history_id: 1, classification: 'inquiry', cosine: 0.7 }),
        baseScore({ sent_history_id: 2, classification: 'inquiry', cosine: 0.5 }),
        baseScore({ sent_history_id: 3, classification: 'reorder', cosine: 0.9 }),
        baseScore({
          sent_history_id: 4,
          classification: null,
          cosine: null,
          status: 'draft_failed',
          error: 'boom',
        }),
      ],
    });

    expect(report.mode).toBe('with-rag');
    expect(report.drafter_model).toBe('qwen3:4b-ctx4k');
    expect(report.embed_model).toBe('nomic-embed-text:v1.5');
    expect(report.sample_size_requested).toBe('all');
    expect(report.sample_size_actual).toBe(4);
    expect(report.aggregates_global.count).toBe(3); // failed pair excluded
    expect(report.aggregates_global.mean).toBeCloseTo((0.7 + 0.5 + 0.9) / 3, 10);
    expect(report.aggregates_by_category.inquiry.count).toBe(2);
    expect(report.aggregates_by_category.reorder.count).toBe(1);
    expect(report.aggregates_by_category.unclassified).toBeUndefined(); // null cosine drops the row
    expect(report.status_counts).toEqual({
      ok: 3,
      draft_failed: 1,
      embed_failed: 0,
      error: 0,
    });
    // ISO-8601 with 'Z' — verify it's parseable, since the file path uses it.
    expect(new Date(report.generated_at).toString()).not.toBe('Invalid Date');
    // Whole report must be JSON-serializable (no Maps, no functions).
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
  });

  it("groups null classifications under 'unclassified' when cosine is present", () => {
    const report = buildReport({
      mode: 'no-rag',
      drafter_model: 'qwen3:4b-ctx4k',
      embed_model: 'nomic-embed-text:v1.5',
      sample_size_requested: 5,
      per_pair: [
        baseScore({ sent_history_id: 1, classification: null, cosine: 0.4 }),
        baseScore({ sent_history_id: 2, classification: null, cosine: 0.6 }),
      ],
    });
    expect(report.aggregates_by_category.unclassified.count).toBe(2);
    expect(report.aggregates_by_category.unclassified.mean).toBeCloseTo(0.5, 10);
  });
});

describe('scorePair — STAQPRO-198', () => {
  const pair: PairRow = {
    sent_history_id: 42,
    sent_message_id: 'reply-msg-1',
    actual_reply_body: 'Thanks for the order — confirmed for shipment Friday.',
    reply_sent_at: '2026-04-15T10:00:00Z',
    inbox_id: 7,
    inbox_message_id: 'inbound-msg-1',
    inbox_from: 'cust@example.com',
    inbox_subject: 'When will my order ship?',
    inbox_body: 'Hi — checking on the order I placed Monday. When does it ship?',
    inbox_classification: 'inquiry',
    inbox_confidence: 0.92,
  };

  // Fixed unit vectors so the test asserts cosine=1 exactly without
  // floating-point fuzz.
  const unitX = (() => {
    const v = new Array(768).fill(0);
    v[0] = 1;
    return v;
  })();

  it('returns ok with cosine=1 when draft and actual both embed identically', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: { content: 'Confirmed for Friday — thanks for the order.' } }),
    );
    const embedMock = vi.fn(async () => unitX);
    const retrieveMock = vi.fn(async () => ({ refs: [], reason: 'no_hits' as const }));
    const personaMock = vi.fn(async () => ({
      tone: 'concise',
      signoff: '— Heron Labs',
      operator_first_name: 'Heron Labs team',
      operator_brand: 'Heron Labs',
    }));

    const score = await scorePair(pair, {
      fetchFn: fetchMock as unknown as typeof fetch,
      embedFn: embedMock as unknown as typeof import('@/lib/rag/embed').embedText,
      retrieve: retrieveMock,
      resolvePersona: personaMock,
    });

    expect(score.status).toBe('ok');
    expect(score.cosine).toBeCloseTo(1, 10);
    expect(score.rag_refs_count).toBe(0);
    expect(score.rag_reason).toBe('no_hits');
    expect(score.classification).toBe('inquiry');
    expect(score.draft_chars).toBeGreaterThan(0);
    expect(score.actual_chars).toBe(pair.actual_reply_body.length);
    // One Ollama call (the drafter); embed called twice (draft + actual).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(embedMock).toHaveBeenCalledTimes(2);
  });

  it('records draft_failed on Ollama 5xx without calling embed', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    const embedMock = vi.fn(async () => unitX);
    const retrieveMock = vi.fn(async () => ({ refs: [], reason: 'no_hits' as const }));
    const personaMock = vi.fn(async () => ({
      tone: 'concise',
      signoff: '— Heron Labs',
      operator_first_name: 'Heron Labs team',
      operator_brand: 'Heron Labs',
    }));

    const score = await scorePair(pair, {
      fetchFn: fetchMock as unknown as typeof fetch,
      embedFn: embedMock as unknown as typeof import('@/lib/rag/embed').embedText,
      retrieve: retrieveMock,
      resolvePersona: personaMock,
    });

    expect(score.status).toBe('draft_failed');
    expect(score.cosine).toBeNull();
    expect(score.error).toMatch(/500/);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('records embed_failed when embedFn returns null', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: { content: 'Confirmed for Friday.' } }),
    );
    const embedMock = vi.fn(async () => null);
    const retrieveMock = vi.fn(async () => ({ refs: [], reason: 'no_hits' as const }));
    const personaMock = vi.fn(async () => ({
      tone: 'concise',
      signoff: '— Heron Labs',
      operator_first_name: 'Heron Labs team',
      operator_brand: 'Heron Labs',
    }));

    const score = await scorePair(pair, {
      fetchFn: fetchMock as unknown as typeof fetch,
      embedFn: embedMock as unknown as typeof import('@/lib/rag/embed').embedText,
      retrieve: retrieveMock,
      resolvePersona: personaMock,
    });

    expect(score.status).toBe('embed_failed');
    expect(score.cosine).toBeNull();
  });

  it('propagates retrieval refs_count + reason through to the score', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ message: { content: 'Confirmed for Friday — thanks.' } }),
    );
    const embedMock = vi.fn(async () => unitX);
    const retrieveMock = vi.fn(async () => ({
      refs: [
        {
          point_id: 'pid-1',
          source: 'past',
          excerpt: 'last order',
          score: 0.9,
          direction: 'outbound' as const,
          sent_at: '2026-03-01T00:00:00Z',
        },
      ],
      reason: 'ok' as const,
    }));
    const personaMock = vi.fn(async () => ({
      tone: 'concise',
      signoff: '— Heron Labs',
      operator_first_name: 'Heron Labs team',
      operator_brand: 'Heron Labs',
    }));

    const score = await scorePair(pair, {
      fetchFn: fetchMock as unknown as typeof fetch,
      embedFn: embedMock as unknown as typeof import('@/lib/rag/embed').embedText,
      retrieve: retrieveMock,
      resolvePersona: personaMock,
    });

    expect(score.rag_refs_count).toBe(1);
    expect(score.rag_reason).toBe('ok');
  });
});

describe('generateDraft — STAQPRO-198', () => {
  it('POSTs to <baseUrl>/api/chat with the assembled messages payload', async () => {
    const pair: PairRow = {
      sent_history_id: 1,
      sent_message_id: 'rmsg',
      actual_reply_body: 'reply',
      reply_sent_at: '2026-04-01T00:00:00Z',
      inbox_id: 1,
      inbox_message_id: 'imsg',
      inbox_from: 'cust@example.com',
      inbox_subject: 'subj',
      inbox_body: 'body',
      inbox_classification: 'inquiry',
      inbox_confidence: 0.9,
    };
    const fetchMock = vi.fn(async () => jsonResponse({ message: { content: 'drafted' } }));
    const retrieveMock = vi.fn(async () => ({ refs: [], reason: 'no_hits' as const }));
    const personaMock = vi.fn(async () => ({
      tone: 'concise',
      signoff: '— Heron Labs',
      operator_first_name: 'Heron Labs team',
      operator_brand: 'Heron Labs',
    }));

    const out = await generateDraft(pair, {
      fetchFn: fetchMock as unknown as typeof fetch,
      retrieve: retrieveMock,
      resolvePersona: personaMock,
    });

    expect(out.body).toBe('drafted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/chat$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: ReadonlyArray<{ role: string; content: string }>;
      stream: boolean;
    };
    expect(body.stream).toBe(false);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    // The user prompt must include the inbound subject + body so the local
    // model has the inbound to draft against.
    expect(body.messages[1].content).toContain('subj');
    expect(body.messages[1].content).toContain('body');
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
