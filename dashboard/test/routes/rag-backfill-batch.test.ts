import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRequest } from '../helpers/db';

// STAQPRO-194: route tests for /api/internal/rag-backfill-batch.
// Mocks the two side-effecting helpers (embed + qdrant upsert) so the test
// is hermetic — direction inference + counts + validation are the
// interesting logic; the embed/qdrant primitives have their own tests.

vi.mock('@/lib/rag/embed', () => ({
  embedText: vi.fn(async (input: string) => {
    if (!input || input.includes('SKIP_EMBED')) return null;
    return Array(768).fill(0.1);
  }),
}));

vi.mock('@/lib/rag/qdrant', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rag/qdrant')>('@/lib/rag/qdrant');
  return {
    ...actual,
    upsertEmailPoint: vi.fn(async (_vec: number[], payload: { message_id: string }) => ({
      ok: true,
      point_id: `mock-${payload.message_id}`,
    })),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/internal/rag-backfill-batch', () => {
  it('returns 400 on missing operator_email', async () => {
    const { POST } = await import('@/app/api/internal/rag-backfill-batch/route');
    const res = await POST(fakeRequest({ body: { rows: [] } }));
    expect(res.status).toBe(400);
  });

  it('returns 400 on bad operator_email format', async () => {
    const { POST } = await import('@/app/api/internal/rag-backfill-batch/route');
    const res = await POST(fakeRequest({ body: { operator_email: 'not-an-email', rows: [] } }));
    expect(res.status).toBe(400);
  });

  it('returns 400 when batch exceeds 5000 rows', async () => {
    const { POST } = await import('@/app/api/internal/rag-backfill-batch/route');
    const rows = Array.from({ length: 5001 }, (_, i) =>
      sampleRow(`m${i}`, 'a@b.io', 'op@heronlabsinc.com'),
    );
    const res = await POST(fakeRequest({ body: { operator_email: 'op@heronlabsinc.com', rows } }));
    expect(res.status).toBe(400);
  });

  it('returns counts for empty batch', async () => {
    const { POST } = await import('@/app/api/internal/rag-backfill-batch/route');
    const res = await POST(
      fakeRequest({ body: { operator_email: 'op@heronlabsinc.com', rows: [] } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      received: 0,
      upserted: 0,
      embedded: 0,
      skipped_no_embed: 0,
      skipped_invalid: 0,
    });
  });

  it('infers outbound direction when from_addr === operator', async () => {
    const { POST } = await import('@/app/api/internal/rag-backfill-batch/route');
    const { upsertEmailPoint } = await import('@/lib/rag/qdrant');
    const res = await POST(
      fakeRequest({
        body: {
          operator_email: 'dustin@heronlabsinc.com',
          rows: [sampleRow('m1', 'Dustin <dustin@heronlabsinc.com>', 'sarah@vendor.com')],
        },
      }),
    );
    expect(res.status).toBe(200);
    const callArgs = (upsertEmailPoint as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1].direction).toBe('outbound');
    expect(callArgs[1].sender).toBe('dustin@heronlabsinc.com');
  });

  it('infers inbound direction when from_addr !== operator', async () => {
    const { POST } = await import('@/app/api/internal/rag-backfill-batch/route');
    const { upsertEmailPoint } = await import('@/lib/rag/qdrant');
    const res = await POST(
      fakeRequest({
        body: {
          operator_email: 'dustin@heronlabsinc.com',
          rows: [sampleRow('m2', 'Eric <eric@staqs.io>', 'dustin@heronlabsinc.com')],
        },
      }),
    );
    expect(res.status).toBe(200);
    const callArgs = (upsertEmailPoint as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1].direction).toBe('inbound');
    expect(callArgs[1].classification_category).toBe('unknown');
  });

  it('counts skipped_no_embed when embed returns null', async () => {
    const { POST } = await import('@/app/api/internal/rag-backfill-batch/route');
    const res = await POST(
      fakeRequest({
        body: {
          operator_email: 'op@heronlabsinc.com',
          rows: [
            { ...sampleRow('m3', 'a@b.io', 'op@heronlabsinc.com'), body: 'SKIP_EMBED here' },
            sampleRow('m4', 'a@b.io', 'op@heronlabsinc.com'),
          ],
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(2);
    expect(body.skipped_no_embed).toBe(1);
    expect(body.embedded).toBe(1);
    expect(body.upserted).toBe(1);
  });
});

function sampleRow(message_id: string, from_addr: string, to_addr: string) {
  return {
    message_id,
    thread_id: `thread-${message_id}`,
    from_addr,
    to_addr,
    subject: `Test ${message_id}`,
    body: `Body content for ${message_id}, normal length sufficient to embed.`,
    sent_at: '2026-04-15T10:00:00Z',
  };
}
