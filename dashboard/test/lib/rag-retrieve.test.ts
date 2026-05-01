import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isCloudRetrievalEnabled, retrieveForDraft } from '@/lib/rag/retrieve';

// STAQPRO-191 — retrieveForDraft contract:
//
//   - Local route → always attempts retrieval
//   - Cloud route + RAG_CLOUD_ROUTE_ENABLED unset → cloud_gated (privacy default)
//   - Cloud route + RAG_CLOUD_ROUTE_ENABLED=1 → attempts retrieval
//   - Embed unavailable → embed_unavailable, no refs
//   - Qdrant unreachable → qdrant_unavailable, no refs
//   - Empty hits → no_hits, no refs
//   - Happy path → ok, refs[] populated with point_id + scored excerpts
//
// All branches MUST return cleanly (never throw) so the draft-prompt route
// can decide drafting falls back to persona-stub.

const baseInput = {
  from_addr: 'cust@example.com',
  subject: 'Re: order',
  body_text: 'Confirming the order details.',
};

function mockEmbedAndSearch(opts: {
  embedding?: number[] | null;
  hits?: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
  searchStatus?: number;
}) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/embeddings')) {
      if (opts.embedding === null) return new Response('boom', { status: 500 });
      const e = opts.embedding ?? new Array(768).fill(0.01);
      return new Response(JSON.stringify({ embedding: e }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/collections/email_messages/points/search')) {
      const status = opts.searchStatus ?? 200;
      if (status !== 200) return new Response('boom', { status });
      return new Response(JSON.stringify({ result: opts.hits ?? [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('retrieveForDraft — STAQPRO-191', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.RAG_CLOUD_ROUTE_ENABLED;

  beforeEach(() => {
    process.env.OLLAMA_BASE_URL = 'http://test-ollama:11434';
    process.env.QDRANT_URL = 'http://test-qdrant:6333';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.RAG_CLOUD_ROUTE_ENABLED;
    else process.env.RAG_CLOUD_ROUTE_ENABLED = originalEnv;
    vi.restoreAllMocks();
  });

  it('returns cloud_gated when draft_source=cloud and env not set', async () => {
    delete process.env.RAG_CLOUD_ROUTE_ENABLED;
    // No fetch should fire — assert by NOT mocking and using a guard.
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('fetch should NOT have been called')) as unknown as typeof fetch;

    const r = await retrieveForDraft({ ...baseInput, draft_source: 'cloud' });
    expect(r.reason).toBe('cloud_gated');
    expect(r.refs).toEqual([]);
  });

  it('returns embed_unavailable when Ollama embed call fails', async () => {
    mockEmbedAndSearch({ embedding: null });
    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('embed_unavailable');
    expect(r.refs).toEqual([]);
  });

  it('returns qdrant_unavailable on Qdrant 5xx', async () => {
    mockEmbedAndSearch({ searchStatus: 500 });
    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('qdrant_unavailable');
    expect(r.refs).toEqual([]);
  });

  it('returns no_hits with empty refs on 0 results', async () => {
    mockEmbedAndSearch({ hits: [] });
    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('no_hits');
    expect(r.refs).toEqual([]);
  });

  it('returns ok with formatted refs on happy path', async () => {
    mockEmbedAndSearch({
      hits: [
        {
          id: 'pid-1',
          score: 0.92,
          payload: {
            message_id: 'm1',
            sender: 'cust@example.com',
            subject: 'Last week order',
            body_excerpt: 'We confirmed the 1000-unit order on March 12.',
            sent_at: '2026-04-15T10:00:00Z',
            direction: 'outbound',
          },
        },
        {
          id: 'pid-2',
          score: 0.81,
          payload: {
            message_id: 'm2',
            sender: 'cust@example.com',
            subject: null,
            body_excerpt: 'Their inbound asking about lead time.',
            sent_at: '2026-04-10T09:00:00Z',
            direction: 'inbound',
          },
        },
      ],
    });

    const r = await retrieveForDraft({ ...baseInput, draft_source: 'local' });
    expect(r.reason).toBe('ok');
    expect(r.refs).toHaveLength(2);
    expect(r.refs[0].point_id).toBe('pid-1');
    expect(r.refs[0].source).toContain('we wrote');
    expect(r.refs[0].source).toContain('2026-04-15');
    expect(r.refs[0].excerpt).toContain('1000-unit');
    expect(r.refs[1].source).toContain('they wrote');
    expect(r.refs[1].source).toContain('(no subject)');
  });

  it('attempts retrieval on cloud route when RAG_CLOUD_ROUTE_ENABLED=1', async () => {
    process.env.RAG_CLOUD_ROUTE_ENABLED = '1';
    mockEmbedAndSearch({ hits: [] });
    const r = await retrieveForDraft({ ...baseInput, draft_source: 'cloud' });
    // Reaches Qdrant (no_hits), not cloud_gated.
    expect(r.reason).toBe('no_hits');
  });

  it('returns no_hits when from_addr is empty (no counterparty filter possible)', async () => {
    mockEmbedAndSearch({ hits: [{ id: 'x', score: 1, payload: {} as never }] });
    const r = await retrieveForDraft({
      from_addr: '',
      subject: 'Hi',
      body_text: 'Hello',
      draft_source: 'local',
    });
    expect(r.reason).toBe('no_hits');
    expect(r.refs).toEqual([]);
  });
});

describe('isCloudRetrievalEnabled — STAQPRO-191', () => {
  it('reflects RAG_CLOUD_ROUTE_ENABLED env at module load', () => {
    // The const captures env at import time so the runtime value is what
    // matters — this is a smoke check that the helper exists and returns
    // a boolean. Branch coverage lives in the cloud_gated test above.
    expect(typeof isCloudRetrievalEnabled()).toBe('boolean');
  });
});
