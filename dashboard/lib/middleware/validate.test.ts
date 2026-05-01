import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseJson, parseParams, parseQuery } from './validate';
import { idParamSchema } from '@/lib/schemas/common';
import {
  listDraftsQuerySchema,
  rejectBodySchema,
  editBodySchema,
} from '@/lib/schemas/drafts';
import {
  draftFinalizeBodySchema,
  draftPromptBodySchema,
} from '@/lib/schemas/internal';

// Minimal NextRequest stand-in: parseJson only touches `.json()` and `.url`,
// so we can hand it a plain object that satisfies the same shape without
// pulling in a Next.js test harness.
function fakeReq({
  body,
  url = 'http://test.local/api/x',
}: {
  body?: unknown;
  url?: string;
}) {
  return {
    url,
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  } as unknown as Parameters<typeof parseJson>[0];
}

describe('parseParams (idParamSchema)', () => {
  it('coerces numeric string to positive integer', () => {
    const r = parseParams({ id: '42' }, idParamSchema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.id).toBe(42);
  });

  it('rejects non-numeric id with 400', () => {
    const r = parseParams({ id: 'abc' }, idParamSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });

  it('rejects zero and negative ids', async () => {
    for (const id of ['0', '-5']) {
      const r = parseParams({ id }, idParamSchema);
      expect(r.ok).toBe(false);
    }
  });
});

describe('parseQuery (listDraftsQuerySchema)', () => {
  it('defaults to status=[pending] when omitted', () => {
    const req = fakeReq({ url: 'http://t/api/drafts' }) as never;
    const r = parseQuery(req, listDraftsQuerySchema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.status).toEqual(['pending']);
      expect(r.data.limit).toBe(50);
    }
  });

  it('parses csv status list', () => {
    const req = fakeReq({
      url: 'http://t/api/drafts?status=pending,approved&limit=10',
    }) as never;
    const r = parseQuery(req, listDraftsQuerySchema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.status).toEqual(['pending', 'approved']);
      expect(r.data.limit).toBe(10);
    }
  });

  it('rejects unknown status with 400', () => {
    const req = fakeReq({
      url: 'http://t/api/drafts?status=bogus',
    }) as never;
    const r = parseQuery(req, listDraftsQuerySchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });

  it('rejects limit > 250', () => {
    const req = fakeReq({
      url: 'http://t/api/drafts?limit=999',
    }) as never;
    const r = parseQuery(req, listDraftsQuerySchema);
    expect(r.ok).toBe(false);
  });
});

describe('parseJson — drafts schemas', () => {
  it('rejectBody accepts empty body', async () => {
    const r = await parseJson(fakeReq({ body: {} }), rejectBodySchema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.reason).toBeNull();
  });

  it('rejectBody trims and accepts reason', async () => {
    const r = await parseJson(
      fakeReq({ body: { reason: '  not on brand  ' } }),
      rejectBodySchema,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.reason).toBe('not on brand');
  });

  it('editBody requires non-empty draft_body', async () => {
    const r = await parseJson(
      fakeReq({ body: { draft_body: '   ' } }),
      editBodySchema,
    );
    expect(r.ok).toBe(false);
  });

  it('editBody rejects body over 10_000 chars', async () => {
    const r = await parseJson(
      fakeReq({ body: { draft_body: 'x'.repeat(10_001) } }),
      editBodySchema,
    );
    expect(r.ok).toBe(false);
  });

  it('editBody preserves draft_body verbatim, nulls missing subject', async () => {
    const r = await parseJson(
      fakeReq({ body: { draft_body: 'Hi Eric,\n\nThanks.' } }),
      editBodySchema,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.draft_body).toBe('Hi Eric,\n\nThanks.');
      expect(r.data.draft_subject).toBeNull();
    }
  });
});

describe('parseJson — internal schemas', () => {
  it('draftPromptBody requires positive draft_id', async () => {
    expect(
      (await parseJson(fakeReq({ body: {} }), draftPromptBodySchema)).ok,
    ).toBe(false);
    expect(
      (await parseJson(fakeReq({ body: { draft_id: 0 } }), draftPromptBodySchema))
        .ok,
    ).toBe(false);
    const r = await parseJson(
      fakeReq({ body: { draft_id: 17 } }),
      draftPromptBodySchema,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.draft_id).toBe(17);
  });

  it('draftFinalizeBody coerces string token counts (n8n compatibility)', async () => {
    const r = await parseJson(
      fakeReq({
        body: {
          draft_id: 17,
          body: 'A reply.',
          source: 'local',
          model: 'qwen3:4b-ctx4k',
          input_tokens: '120',
          output_tokens: '64',
        },
      }),
      draftFinalizeBodySchema,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.input_tokens).toBe(120);
      expect(r.data.output_tokens).toBe(64);
    }
  });

  it('draftFinalizeBody rejects unknown source', async () => {
    const r = await parseJson(
      fakeReq({
        body: {
          draft_id: 1,
          body: 'X',
          source: 'magic',
          model: 'm',
        },
      }),
      draftFinalizeBodySchema,
    );
    expect(r.ok).toBe(false);
  });

  it('draftFinalizeBody defaults missing token fields to 0', async () => {
    const r = await parseJson(
      fakeReq({
        body: {
          draft_id: 1,
          body: 'X',
          source: 'cloud',
          model: 'gpt-oss:120b',
        },
      }),
      draftFinalizeBodySchema,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.input_tokens).toBe(0);
      expect(r.data.output_tokens).toBe(0);
    }
  });
});

describe('parseJson error response shape', () => {
  it('emits 400 with { error: validation_failed, issues: [...] }', async () => {
    const r = await parseJson(
      fakeReq({ body: { draft_id: 'not-a-number' } }),
      draftPromptBodySchema,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(400);
      const json = (await r.response.json()) as {
        error: string;
        issues: ReadonlyArray<{ path: string }>;
      };
      expect(json.error).toBe('validation_failed');
      expect(json.issues.length).toBeGreaterThan(0);
      expect(json.issues[0].path).toContain('draft_id');
    }
  });

  it('returns 400 when JSON body is missing entirely', async () => {
    const fake = {
      url: 'http://t/x',
      json: async () => {
        throw new Error('not JSON');
      },
    } as unknown as Parameters<typeof parseJson>[0];
    const schema = z.object({ x: z.string() });
    const r = await parseJson(fake, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });
});
