import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { reclassifyBySender } from '@/lib/queries-sender-allowlist';
import { reclassifyBySenderBodySchema } from '@/lib/schemas/classifications';

export const dynamic = 'force-dynamic';

// MBOX-370 — operator "reclassify automatically" for a sender. Operator-facing
// (Caddy basic_auth gated at the public edge); called from the /classifications
// page. Replaces the MBOX-368 force-to-category model (operator feedback: a
// sender wrongly dropped as spam can send any non-spam type later).
//
// Two halves (see lib/queries-sender-allowlist.ts:reclassifyBySender):
//   - FUTURE: upsert the sender into mailbox.sender_never_spam so the classify-
//     time guard surfaces (never drops) their mail going forward.
//   - PAST: re-run the REAL classifier on the sender's existing emails so they
//     get their correct category and leave the spam bucket. Relabel only — NO
//     drafts are generated for historical dropped mail (operator decision).
//
// Body { email, reason? } (zod reclassifyBySenderBodySchema; `email` normalized
// via extractAddress). Returns { success, email, reclassified, surfaced, truncated }.
export async function POST(req: NextRequest) {
  const b = await parseJson(req, reclassifyBySenderBodySchema);
  if (!b.ok) return b.response;
  const { email, reason } = b.data;

  try {
    const result = await reclassifyBySender({ email, reason });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('POST /api/classifications/reclassify-sender failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
