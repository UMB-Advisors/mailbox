// Spec 002 FR7/FR7b (Stage 2b-2) — classifyOne integration of the two new
// surfaces: (1) Reverb subject hard-route short-circuits the LLM; (2) injected
// exemplars are rendered into the prompt the model sees. Persona + Ollama base
// URL are mocked; the LLM call is a captured fetch stub (no network).

import { describe, expect, it, vi } from 'vitest';

vi.mock('@umb-advisors/llm', () => ({ readOllamaBaseUrl: () => 'http://ollama:11434' }));
vi.mock('@/lib/drafting/persona', () => ({
  getPersonaContext: vi.fn(async () => ({
    operator_brand: 'Acme',
    business_description: 'a guitar shop',
  })),
}));

import { classifyOne, type InboxRowForClassify } from '@/lib/classification/classify-one';

const baseRow: InboxRowForClassify = {
  id: 1,
  from_addr: null,
  to_addr: null,
  subject: null,
  body: null,
  snippet: null,
};

function okFetch(captured: { prompt?: string }): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    captured.prompt = body.prompt;
    return {
      ok: true,
      json: async () => ({ response: '{"category":"internal","confidence":0.9}' }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('classifyOne — Reverb subject hard-route (FR7, 2b-2)', () => {
  it('routes a Reverb "Message about…" subject to sales_lead WITHOUT calling the LLM', async () => {
    const fetchImpl = vi.fn();
    const out = await classifyOne(
      {
        ...baseRow,
        from_addr: 'Reverb <messages@reverb.com>',
        subject: 'Message about your Stratocaster',
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(out.category).toBe('sales_lead');
    expect(out.preclass_source).toBe('reverb-subject');
    expect(out.preclass_applied).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('REVERB_ROUTING_DISABLE=1 falls through to the LLM', async () => {
    process.env.REVERB_ROUTING_DISABLE = '1';
    const captured: { prompt?: string } = {};
    try {
      const out = await classifyOne(
        { ...baseRow, from_addr: 'messages@reverb.com', subject: 'Message about a Tele' },
        { fetchImpl: okFetch(captured) },
      );
      expect(out.preclass_source).not.toBe('reverb-subject');
      expect(captured.prompt).toBeTruthy();
    } finally {
      delete process.env.REVERB_ROUTING_DISABLE;
    }
  });
});

describe('classifyOne — few-shot exemplar injection (FR7b, 2b-2)', () => {
  it('passes injected exemplars into the prompt the LLM receives', async () => {
    const captured: { prompt?: string } = {};
    const exemplarLookup = vi.fn(async () => [
      { snippet: 'EXEMPLAR_MARKER team sync', bucket: 'internal' as const },
    ]);
    const out = await classifyOne(
      { ...baseRow, from_addr: 'a@b.com', subject: 'hello', body: 'hi' },
      { fetchImpl: okFetch(captured), exemplarLookup },
    );
    expect(exemplarLookup).toHaveBeenCalledOnce();
    expect(captured.prompt).toContain('Examples —');
    expect(captured.prompt).toContain('EXEMPLAR_MARKER team sync');
    expect(out.category).toBe('internal');
  });

  it('omitted exemplarLookup → no Examples block (unchanged prompt)', async () => {
    const captured: { prompt?: string } = {};
    await classifyOne(
      { ...baseRow, from_addr: 'a@b.com', subject: 'hello', body: 'hi' },
      { fetchImpl: okFetch(captured) },
    );
    expect(captured.prompt).not.toContain('Examples —');
  });
});
