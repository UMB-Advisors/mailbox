import { sql } from 'kysely';
import { NextResponse } from 'next/server';
import { getKysely } from '@/lib/db';
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
  // Wrap in a transaction so we can SET LOCAL the actor/reason GUCs that the
  // mailbox.state_transitions trigger reads (STAQPRO-185). Without these,
  // the trigger still fires but logs actor='system'.
  try {
    const db = getKysely();
    const rows = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('mailbox.actor', 'operator', true)`.execute(trx);
      await sql`SELECT set_config('mailbox.transition_reason', ${opts.routeName}, true)`.execute(
        trx,
      );
      return trx
        .updateTable('drafts')
        .set({
          status: 'approved',
          updated_at: sql<string>`NOW()`,
          ...(opts.clearError ? { error_message: null } : {}),
        })
        .where('id', '=', id)
        .where('status', 'in', opts.fromStates as readonly string[])
        .returning(['id', 'status'])
        .execute();
    });
    if (rows.length === 0) {
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
