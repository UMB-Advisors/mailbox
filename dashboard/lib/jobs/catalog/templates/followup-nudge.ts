// dashboard/lib/jobs/catalog/templates/followup-nudge.ts
//
// T2 — Follow-up / no-reply nudge (MBOX-462, spec §4). Detection is LIVE
// (MBOX-377: getAwaitingReply + the amber digest section), but the auto-nudge
// SENDING workflow is net-new — so this template ships as `availability:
// 'planned'`: visible in the catalog, not yet enable-able into a running
// instance. P2 builds the MailBOX-Followup workflow and flips it to available.
//
// Rail A (n8n schedule + Gmail reply; needs the rate-limit circuit breaker).
// It sends to counterparties → never recommended-on-by-default (spec §9 D3).

import type { N8nJobTemplate } from '../types';

export const followupNudge: N8nJobTemplate = {
  id: 'followup-nudge',
  rail: 'n8n',
  workflow: 'MailBOX-Followup', // planned — not yet in n8n/workflows/
  availability: 'planned',
  title: 'Follow-up / no-reply nudge',
  summary:
    'Finds sent replies that got no response after N days and (with approval) drafts a polite nudge. Detection is live today; auto-nudge sending is planned.',
  trigger: { kind: 'schedule', default: '0 9 * * *' },
  sendsToCounterparty: true,
  recommendOnByDefault: false,
  entitlement: { minTier: 'core' },
  params: [
    {
      key: 'age_hours',
      label: 'Nudge after (hours)',
      type: 'number',
      required: true,
      default: 72,
      help: 'How long a thread can sit with no reply before it is eligible for a nudge.',
    },
    {
      key: 'auto_draft',
      label: 'Auto-draft nudge',
      type: 'boolean',
      required: false,
      default: false,
      help: 'When on, drafts a nudge into the approval queue. Off = surface in the digest only.',
    },
  ],
};
