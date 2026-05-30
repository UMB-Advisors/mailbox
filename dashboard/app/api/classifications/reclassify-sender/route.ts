import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { reclassifyBySender } from '@/lib/queries-sender-overrides';
import { reclassifyBySenderBodySchema } from '@/lib/schemas/classifications';

export const dynamic = 'force-dynamic';

// MBOX-368 — operator reclassify-by-sender. Operator-facing (Caddy basic_auth
// gated at the public edge); called from the /classifications page.
//
// Extends MBOX-123 (PATCH /api/drafts/[id]/classification): that route relabels
// a SINGLE draft keyed on a draft id and so cannot touch spam_marketing rows
// (dropped → no draft) and has no per-sender fan-out. This route is keyed on the
// SENDER address instead and does both halves of "reclassify all mail from this
// address":
//   - PAST: relabel every inbox_messages row from the sender + append a
//     classification_log audit row per message + relabel any existing drafts.
//   - FUTURE: upsert a mailbox.sender_classification_overrides row that the
//     classify-time preclass forces on all subsequent inbound from the address.
// Relabel only — no drafts generated for historical dropped mail.
//
// Body { email, category, reason? } (zod reclassifyBySenderBodySchema; `email`
// normalized via extractAddress, `category` anchored to CATEGORIES). All writes
// happen in one transaction (see lib/queries-sender-overrides.ts).
export async function POST(req: NextRequest) {
  const b = await parseJson(req, reclassifyBySenderBodySchema);
  if (!b.ok) return b.response;
  const { email, category, reason } = b.data;

  try {
    const result = await reclassifyBySender({ email, category, reason });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('POST /api/classifications/reclassify-sender failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
