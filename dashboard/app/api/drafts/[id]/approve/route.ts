import type { NextRequest } from 'next/server';
import { parseParams } from '@/lib/middleware/validate';
import { idParamSchema } from '@/lib/schemas/common';
import { transitionToApprovedAndSend } from '@/lib/transitions';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;

  // STAQPRO-202 — 'failed' dropped from fromStates after migration 016
  // retired the status. Send-side errors now leave the row at 'approved';
  // the retry route handles operator-driven recovery.
  return transitionToApprovedAndSend(p.data.id, {
    fromStates: ['pending', 'edited'],
    fromStatesLabel: 'pending or edited',
    clearError: false,
    routeName: 'approve',
  });
}
