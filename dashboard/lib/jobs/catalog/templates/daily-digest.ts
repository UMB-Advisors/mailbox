// dashboard/lib/jobs/catalog/templates/daily-digest.ts
//
// T1 — Daily inbox digest (MBOX-462, spec §4). Already live as the
// MailBOX-Digest n8n workflow + lib/digest/* render + /api/internal/digest.
// This template formalizes that into the catalog so the operator can
// see/toggle it from the Jobs surface (P1) and tune the send hour/recipient.
//
// Rail A (n8n schedule → dashboard render). The digest emails the OPERATOR a
// rollup — it is NOT a counterparty send, so it is allowed to be
// recommended-on-by-default (the cold-start value the spec is chasing).

import type { N8nJobTemplate } from '../types';

export const dailyDigest: N8nJobTemplate = {
  id: 'daily-digest',
  rail: 'n8n',
  workflow: 'MailBOX-Digest',
  availability: 'available',
  title: 'Daily inbox digest',
  summary:
    'Once-a-day rollup of the queue — urgent items, threads awaiting a reply, and volume — emailed to the operator each morning.',
  trigger: { kind: 'schedule', default: 'DIGEST_SEND_HOUR_LOCAL' },
  sendsToCounterparty: false,
  recommendOnByDefault: true,
  entitlement: { minTier: 'core' },
  params: [
    {
      key: 'send_hour_local',
      label: 'Send hour (local)',
      type: 'number',
      required: true,
      default: 7,
      help: 'Hour of day (0–23) in the box timezone to send the digest.',
    },
    {
      key: 'recipient',
      label: 'Recipient',
      type: 'string',
      required: false,
      help: 'Defaults to MAILBOX_OPERATOR_EMAIL, then the onboarding email.',
    },
  ],
};
