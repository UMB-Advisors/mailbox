import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { triggerSendWebhook } from '@/lib/n8n';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const id = parseInt(params.id, 10);
  if (Number.isNaN(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  // Step 1: flip status to 'approved' (only from pending/edited/failed).
  try {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE mailbox.drafts
          SET status = 'approved',
              updated_at = now()
        WHERE id = $1
          AND status IN ('pending', 'edited', 'failed')
        RETURNING id, status`,
      [id],
    );
    if (result.rowCount === 0) {
      return NextResponse.json(
        { error: 'Draft not in pending, edited, or failed state' },
        { status: 409 },
      );
    }
  } catch (error) {
    console.error(`POST /api/drafts/${id}/approve (status update) failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }

  // Step 2: fire the n8n webhook. Do NOT roll back on failure — operator
  // retries via /retry, which keeps the row at 'approved' and re-fires.
  const webhookResult = await triggerSendWebhook(id);
  if (!webhookResult.success) {
    console.error(
      `POST /api/drafts/${id}/approve (webhook) failed:`,
      webhookResult.error,
    );
    return NextResponse.json(
      {
        success: false,
        draft_id: id,
        error: webhookResult.error,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    draft_id: id,
    webhook_response: webhookResult.response,
  });
}
