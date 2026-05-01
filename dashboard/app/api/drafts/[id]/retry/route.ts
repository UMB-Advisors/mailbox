import { type NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { parseParams } from '@/lib/middleware/validate';
import { triggerSendWebhook } from '@/lib/n8n';
import { idParamSchema } from '@/lib/schemas/common';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const p = parseParams(params, idParamSchema);
  if (!p.ok) return p.response;
  const { id } = p.data;

  // Reset failed → approved, clear error_message; only from 'failed' status.
  try {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE mailbox.drafts
          SET status = 'approved',
              error_message = NULL,
              updated_at = now()
        WHERE id = $1
          AND status = 'failed'
        RETURNING id`,
      [id],
    );
    if (result.rowCount === 0) {
      return NextResponse.json({ error: 'Draft not in failed state' }, { status: 409 });
    }
  } catch (error) {
    console.error(`POST /api/drafts/${id}/retry (status update) failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }

  // Re-fire the n8n webhook. On failure leave row at 'approved' so a subsequent
  // retry can re-fire without state surgery.
  const webhookResult = await triggerSendWebhook(id);
  if (!webhookResult.success) {
    console.error(`POST /api/drafts/${id}/retry (webhook) failed:`, webhookResult.error);
    return NextResponse.json(
      { success: false, draft_id: id, error: webhookResult.error },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    draft_id: id,
    webhook_response: webhookResult.response,
  });
}
