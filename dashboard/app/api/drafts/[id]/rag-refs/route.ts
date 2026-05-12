// dashboard/app/api/drafts/[id]/rag-refs/route.ts
//
// STAQPRO-331 #2 — resolve a draft's rag_context_refs back to source
// messages so the queue UI can render a "Sources used" panel.
//
// drafts.rag_context_refs is a jsonb array of Qdrant point UUIDs (one per
// retrieved ref at draft-assembly time, STAQPRO-191). The UUIDs are
// deterministic via pointIdFromMessageId() but the hash is one-way — we
// can't reverse a UUID to a message_id without round-tripping through
// Qdrant. Fortunately Qdrant retains the full EmailPointPayload (sender,
// subject, body_excerpt, sent_at, direction, classification_category), so
// one batch GET against Qdrant returns everything the UI needs.
//
// When rag_context_refs is empty, drafts.rag_retrieval_reason discriminates
// why (cloud_gated / embed_unavailable / no_hits / qdrant_unavailable /
// disabled / none). The route surfaces that reason so the operator knows
// the draft drafted without context, and why.

import { type NextRequest, NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
import { parseParams } from '@/lib/middleware/validate';
import { getPointsByIds } from '@/lib/rag/qdrant';
import { idParamSchema } from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';

interface SourceRef {
  point_id: string;
  message_id: string;
  sender: string;
  recipient: string;
  subject: string | null;
  body_excerpt: string;
  sent_at: string;
  direction: 'inbound' | 'outbound';
  classification_category: string | null;
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  const db = getKysely();
  const row = await db
    .selectFrom('drafts')
    .select(['rag_context_refs', 'rag_retrieval_reason'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) {
    return NextResponse.json({ error: 'draft_not_found' }, { status: 404 });
  }

  // rag_context_refs is jsonb — kysely-codegen types it as `unknown` since
  // jsonb is structurally untyped. Defensively validate the array shape.
  const rawRefs = row.rag_context_refs;
  const pointIds = Array.isArray(rawRefs)
    ? rawRefs.filter((r): r is string => typeof r === 'string')
    : [];

  if (pointIds.length === 0) {
    return NextResponse.json({
      reason: row.rag_retrieval_reason,
      refs: [] as SourceRef[],
    });
  }

  const result = await getPointsByIds(pointIds);
  if (!result.ok) {
    // Qdrant outage — return the IDs we know about so the UI can render
    // a partial ("3 refs but Qdrant unreachable, can't resolve right now").
    return NextResponse.json({
      reason: row.rag_retrieval_reason,
      qdrant_error: result.reason ?? 'unknown',
      refs: [] as SourceRef[],
      unresolved_point_ids: pointIds,
    });
  }

  const refs: SourceRef[] = result.points.map((p) => ({
    point_id: p.id,
    message_id: p.payload.message_id,
    sender: p.payload.sender,
    recipient: p.payload.recipient,
    subject: p.payload.subject,
    body_excerpt: p.payload.body_excerpt,
    sent_at: p.payload.sent_at,
    direction: p.payload.direction,
    classification_category: p.payload.classification_category,
  }));

  // Preserve the order the drafter saw them in — point_id order from the
  // stored jsonb array. Qdrant's batch-get doesn't guarantee ordering.
  const byPointId = new Map(refs.map((r) => [r.point_id, r]));
  const ordered = pointIds
    .map((pid) => byPointId.get(pid))
    .filter((r): r is SourceRef => r !== undefined);

  return NextResponse.json({
    reason: row.rag_retrieval_reason,
    refs: ordered,
  });
}
