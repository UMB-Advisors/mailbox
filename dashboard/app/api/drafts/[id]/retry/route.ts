import type { NextRequest } from 'next/server';
import { parseParams } from '@/lib/middleware/validate';
import { idParamSchema } from '@/lib/schemas/common';
import { transitionToApprovedAndSend } from '@/lib/transitions';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;

  // STAQPRO-202 — retry only advances rows stuck at status='approved'. The
  // 'failed' status was retired in migration 016 (MailBOX-Send no longer
  // flips to 'failed'; Gmail Reply errors leave the row at 'approved'). The
  // stuck-at-approved case covers: dashboard flipped status='approved'
  // before firing the n8n webhook, but n8n crashed mid-send OR Mark Sent
  // failed after Gmail Reply succeeded. Operator-side mitigation for the
  // resulting double-send risk: the StuckApproved UI surfaces a 5s arm
  // window + "may have already sent — verify in Gmail Sent" warning before
  // firing.
  return transitionToApprovedAndSend(p.data.id, {
    fromStates: ['approved'],
    fromStatesLabel: 'approved',
    clearError: true,
    routeName: 'retry',
  });
}
