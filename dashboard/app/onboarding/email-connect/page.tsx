'use client';

import { StepShell } from '../_components/StepShell';

// TODO(STAQPRO-152): real Gmail OAuth flow + n8n credential handoff
// (architectural — needs spec). Per-customer OAuth client today (STAQPRO-197
// tracks the shared-client move post-Google App Verification). The flow
// must end with a refresh token written into n8n's credentials_entity table
// under the credential id n8n's workflows reference. Cleanest path is
// likely a one-shot CLI in `scripts/gmail-oauth.ts` invoked by the wizard
// route rather than embedding the full OAuth dance in the dashboard.
export default function EmailConnectPage() {
  return (
    <StepShell slug="email-connect">
      <h2 className="mb-2 text-sm font-semibold text-neutral-200">What this step will do</h2>
      <ul className="list-disc space-y-1 pl-5 text-neutral-400">
        <li>
          Open a Gmail consent screen so the appliance can read inbox + send replies on your behalf.
        </li>
        <li>Hand the resulting refresh token to n8n's encrypted credential store.</li>
        <li>
          Kick off the first 90-day backfill so the persona extractor has a corpus to learn from.
        </li>
      </ul>
    </StepShell>
  );
}
