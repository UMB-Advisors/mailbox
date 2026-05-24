import { sql } from 'kysely';
import { type NextRequest, NextResponse } from 'next/server';
import { getKysely, normalizeDraftBody } from '@/lib/db';
import { extractActionItems } from '@/lib/drafting/action-items';
import { computeCost } from '@/lib/drafting/cost';
import { parseJson } from '@/lib/middleware/validate';
import { draftFinalizeBodySchema } from '@/lib/schemas/internal';

export const dynamic = 'force-dynamic';

// Single write path for the new draft-generation pipeline (Linus + Neo's
// API-boundary recommendation, 2026-04-30).
//
// n8n 04-draft-sub calls this AFTER the Ollama HTTP call returns. It hands us
// the body + token counts; we compute cost via PRICING (not n8n's job),
// validate, and persist. n8n never writes to mailbox.drafts directly for the
// new path.

export async function POST(req: NextRequest) {
  const b = await parseJson(req, draftFinalizeBodySchema);
  if (!b.ok) return b.response;
  const { draft_id, body, source, model, input_tokens, output_tokens } = b.data;

  try {
    const cost_usd = computeCost(model, input_tokens, output_tokens);
    const cleanBody = normalizeDraftBody(body);

    const db = getKysely();
    const rows = await db
      .updateTable('drafts')
      .set({
        draft_body: cleanBody,
        draft_source: source,
        model,
        input_tokens,
        output_tokens,
        cost_usd,
        updated_at: sql<string>`NOW()`,
      })
      .where('id', '=', draft_id)
      .returning([
        'id',
        'status',
        'draft_source',
        'model',
        'input_tokens',
        'output_tokens',
        'cost_usd',
      ])
      .execute();

    if (rows.length === 0) {
      return NextResponse.json({ error: `draft ${draft_id} not found` }, { status: 404 });
    }

    // MBOX-131 — extract structured action items from the inbound + the draft
    // reply, then persist into drafts.action_items. Strictly non-gating: a
    // failure here leaves action_items at its '[]' default and does NOT change
    // the response shape or the draft status (status is owned by the classify
    // path, not finalize — see the n8n boundary contract). Bounded by the 2s
    // extraction timeout. We fetch the inbound from inbox_messages (its body is
    // the counterparty's text; the draft's denormalized from_addr/body_text are
    // the reply side, not the inbound).
    try {
      const inbound = await db
        .selectFrom('drafts as d')
        .innerJoin('inbox_messages as m', 'd.inbox_message_id', 'm.id')
        .where('d.id', '=', draft_id)
        .select([
          'm.from_addr as from_addr',
          'm.subject as subject',
          'm.body as body',
          'm.classification as classification',
          'm.confidence as confidence',
        ])
        .executeTakeFirst();
      if (inbound) {
        const action_items = await extractActionItems({
          draftId: draft_id,
          draftBody: cleanBody,
          inbound: {
            from_addr: inbound.from_addr,
            subject: inbound.subject,
            body_text: inbound.body,
            classification_category: inbound.classification,
            // inbox_messages.confidence is NUMERIC (pg returns string); coerce
            // to a number for routeFor, defaulting to 0 (-> cloud safety net).
            classification_confidence:
              inbound.confidence != null ? Number(inbound.confidence) : null,
          },
        });
        await db
          .updateTable('drafts')
          .set({ action_items: sql`${JSON.stringify(action_items)}::jsonb` })
          .where('id', '=', draft_id)
          .execute();
      }
    } catch (err) {
      // Already returns [] on internal failure; this guards the DB read/write
      // around extraction. Never let it affect the finalize response.
      console.warn(
        `draft-finalize action-item extraction failed draft=${draft_id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // rows[0].cost_usd is the persisted NUMERIC-as-string value — same shape
    // n8n's HTTP node previously consumed. computeCost(...) above is the
    // source-of-truth calculation; rows[0] echoes what was just written.
    return NextResponse.json({
      ok: true,
      draft_id,
      ...rows[0],
    });
  } catch (error) {
    console.error('POST /api/internal/draft-finalize failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
