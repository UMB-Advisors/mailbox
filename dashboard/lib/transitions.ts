import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { triggerSendWebhook } from '@/lib/n8n';
import type { DraftStatus } from '@/lib/types';

// Shared helper for approve/retry, which both transition a draft to
// `status='approved'` and fire the n8n send webhook (STAQPRO-140).
// Differences between the two routes are passed as options:
//   - approve allows from {pending, edited, failed}, doesn't touch error_message
//   - retry only allows from {failed}, clears error_message
//
// Webhook failure does NOT roll back the status update — operator can re-fire
// via /retry, which keeps the row at 'approved' and re-tries the webhook
// without any state surgery.

interface TransitionOptions {
  fromStates: ReadonlyArray<DraftStatus>;
  fromStatesLabel: string; // surfaced in the 409 error message
  clearError: boolean;
  routeName: string; // for log breadcrumbs
}

export async function transitionToApprovedAndSend(
  id: number,
  opts: TransitionOptions,
): Promise<NextResponse> {
  // Step 1: flip status to 'approved' (only from the allowed source states).
  try {
    const pool = getPool();
    const setClauses = opts.clearError
      ? `status = 'approved', error_message = NULL, updated_at = now()`
      : `status = 'approved', updated_at = now()`;
    const result = await pool.query(
      `UPDATE mailbox.drafts
          SET ${setClauses}
        WHERE id = $1
          AND status = ANY($2::text[])
        RETURNING id, status`,
      [id, [...opts.fromStates]],
    );
    if (result.rowCount === 0) {
      return NextResponse.json(
        { error: `Draft not in ${opts.fromStatesLabel} state` },
        { status: 409 },
      );
    }
  } catch (error) {
    console.error(`POST /api/drafts/${id}/${opts.routeName} (status update) failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }

  // Step 2: fire the n8n webhook.
  const webhookResult = await triggerSendWebhook(id);
  if (!webhookResult.success) {
    console.error(
      `POST /api/drafts/${id}/${opts.routeName} (webhook) failed:`,
      webhookResult.error,
    );
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
