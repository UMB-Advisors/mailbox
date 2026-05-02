import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { embedText } from '@/lib/rag/embed';
import { buildBodyExcerpt, buildEmbeddingInput } from '@/lib/rag/excerpt';
import { type Direction, upsertEmailPoint } from '@/lib/rag/qdrant';
import { ragBackfillBatchSchema } from '@/lib/schemas/rag-backfill';

// STAQPRO-194: receives a batch of historical Gmail messages from the
// MailBOX-RAG-Backfill n8n workflow, embeds each via local nomic-embed-text,
// and upserts to Qdrant `email_messages`. Idempotent on Gmail message_id via
// upsertEmailPoint's deterministic point UUIDs (re-running with the same
// window produces zero new points).
//
// Direction inference: from_addr.toLowerCase() === operator_email.toLowerCase()
// → outbound; else → inbound. Email parsing extracts the address from
// "Name <addr@host>" envelopes.
//
// Classification on backfill: skipped per the STAQPRO-194 ticket open-Q
// resolution — historical rows are tagged classification_category='unknown'.
// Live forward-moving inbound continues to flow through the live classify
// pipeline (n8n MailBOX-Classify) and writes the proper category.

export const dynamic = 'force-dynamic';

export interface BatchResult {
  received: number;
  upserted: number;
  embedded: number;
  skipped_no_embed: number;
  skipped_invalid: number;
  errors: string[];
}

export async function POST(request: NextRequest) {
  const parsed = await parseJson(request, ragBackfillBatchSchema);
  if (!parsed.ok) return parsed.response;

  const operatorAddr = extractAddr(parsed.data.operator_email).toLowerCase();
  const result: BatchResult = {
    received: parsed.data.rows.length,
    upserted: 0,
    embedded: 0,
    skipped_no_embed: 0,
    skipped_invalid: 0,
    errors: [],
  };

  for (const row of parsed.data.rows) {
    try {
      const fromAddr = extractAddr(row.from_addr);
      const toAddr = extractAddr(row.to_addr);
      if (!fromAddr || !toAddr) {
        result.skipped_invalid += 1;
        continue;
      }
      const direction: Direction = fromAddr.toLowerCase() === operatorAddr ? 'outbound' : 'inbound';

      const bodyExcerpt = buildBodyExcerpt(row.body);
      const embedInput = buildEmbeddingInput(row.subject, bodyExcerpt);
      const vec = await embedText(embedInput);
      if (!vec) {
        result.skipped_no_embed += 1;
        continue;
      }
      result.embedded += 1;

      const upsert = await upsertEmailPoint(vec, {
        message_id: row.message_id,
        thread_id: row.thread_id,
        sender: fromAddr,
        recipient: toAddr,
        subject: row.subject,
        body_excerpt: bodyExcerpt,
        sent_at: row.sent_at,
        direction,
        classification_category: 'unknown',
      });
      if (upsert.ok) {
        result.upserted += 1;
      } else {
        result.errors.push(`${row.message_id}: ${upsert.reason ?? 'upsert failed'}`);
      }
    } catch (err) {
      result.errors.push(
        `${row.message_id}: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }

  return NextResponse.json(result satisfies BatchResult);
}

// "Eric Gang <eric@staqs.io>" → "eric@staqs.io"
// "eric@staqs.io" → "eric@staqs.io"
// "" → ""
function extractAddr(envelope: string): string {
  const m = envelope.match(/<([^>]+)>/);
  return (m ? m[1] : envelope).trim();
}
