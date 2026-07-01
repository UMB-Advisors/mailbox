import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeRequest } from '../helpers/db';

// n8n-wire (Spec 002 FR7/FR7b reaching the LIVE pipeline) — `/api/internal/
// classification-prompt` now runs the shared force/reverb preclass (only to
// derive a `senderPrior` for a `bias` hit — a `force` hit must NOT change the
// prompt-building behavior here, since `classification-normalize` overrides
// the category independently regardless of what the LLM says) and injects
// few-shot exemplars. All DB-backed dependencies are mocked — no live
// Postgres, no live Ollama.
vi.mock('@umb-advisors/llm', () => ({ readOllamaBaseUrl: () => 'http://ollama:11434' }));
vi.mock('@/lib/drafting/persona', () => ({
  getPersonaContext: vi.fn(async () => ({
    operator_brand: 'Acme',
    business_description: 'a guitar shop',
  })),
}));
vi.mock('@/lib/classification/sender-rules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/classification/sender-rules')>();
  return { ...actual, senderRule: vi.fn(async () => null) };
});
vi.mock('@/lib/classification/exemplars', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/classification/exemplars')>();
  return { ...actual, retrieveClassificationExemplars: vi.fn(async () => []) };
});

import { retrieveClassificationExemplars } from '@/lib/classification/exemplars';
import { senderRule } from '@/lib/classification/sender-rules';

const mockedSenderRule = vi.mocked(senderRule);
const mockedExemplars = vi.mocked(retrieveClassificationExemplars);

describe('POST /api/internal/classification-prompt — n8n-wire additions', () => {
  afterEach(() => {
    mockedSenderRule.mockReset();
    mockedSenderRule.mockResolvedValue(null);
    mockedExemplars.mockReset();
    mockedExemplars.mockResolvedValue([]);
  });

  it('force-mode sender still returns a normal, valid prompt (no skip)', async () => {
    mockedSenderRule.mockResolvedValue({
      match: 'gemini-notes@google.com',
      kind: 'email',
      target_bucket: 'meeting_notes',
      mode: 'force',
    });
    const { POST } = await import('@/app/api/internal/classification-prompt/route');
    const res = await POST(
      fakeRequest({
        body: {
          from: 'gemini-notes@google.com',
          subject: 'Notes: Weekly sync',
          body: 'Attendees: ...',
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.prompt).toBe('string');
    expect(body.prompt.length).toBeGreaterThan(0);
    expect(body.model).toBeTruthy();
    // The prompt is the normal classifier prompt — no sender-prior hint,
    // since a force hit doesn't set senderPrior (it short-circuits elsewhere).
    expect(body.prompt).not.toContain('Prior:');
  });

  it('bias-mode sender injects a senderPrior hint into the prompt', async () => {
    mockedSenderRule.mockResolvedValue({
      match: 'reverb.com',
      kind: 'domain',
      target_bucket: 'sales_lead',
      mode: 'bias',
    });
    const { POST } = await import('@/app/api/internal/classification-prompt/route');
    const res = await POST(
      fakeRequest({
        body: {
          from: 'messages@reverb.com',
          subject: 'A new message from a buyer',
          body: 'Hi, is this still available?',
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompt).toContain('Prior:');
    expect(body.prompt).toContain('sales_lead');
    expect(mockedExemplars).toHaveBeenCalledWith(
      expect.objectContaining({ senderPrior: 'sales_lead' }),
    );
  });

  it('a normal message with no sender rule returns the unchanged description-only prompt', async () => {
    const { POST } = await import('@/app/api/internal/classification-prompt/route');
    const res = await POST(
      fakeRequest({
        body: {
          from: 'customer@example.com',
          subject: 'Question about my order',
          body: 'When will my order ship?',
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompt).not.toContain('Prior:');
    expect(body.prompt).not.toContain('Examples —');
  });
});
