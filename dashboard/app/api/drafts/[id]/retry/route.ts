import type { NextRequest } from 'next/server';
import { parseParams } from '@/lib/middleware/validate';
import { idParamSchema } from '@/lib/schemas/common';
import { transitionToApprovedAndSend } from '@/lib/transitions';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;

  return transitionToApprovedAndSend(p.data.id, {
    fromStates: ['failed'],
    fromStatesLabel: 'failed',
    clearError: true,
    routeName: 'retry',
  });
}
