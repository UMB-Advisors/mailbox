'use client';

import { StepShell } from '../_components/StepShell';

// TODO(STAQPRO-152): show first-poll ETA + link to /dashboard/queue +
// send "you're live" email. The 5-minute Schedule trigger means the first
// draft can take up to 5 minutes to appear; the page should show a small
// countdown sourced from the parent workflow's `nextRunAt` (read via the
// n8n REST API or a /api/system/status helper).
export default function CompletePage() {
  return (
    <StepShell slug="complete">
      <h2 className="mb-2 text-sm font-semibold text-neutral-200">What this step will do</h2>
      <ul className="list-disc space-y-1 pl-5 text-neutral-400">
        <li>Confirm the appliance is now polling Gmail every 5 minutes.</li>
        <li>Send a one-time "you're live" email so the operator knows the send path works.</li>
        <li>Hand off to the queue, where the very first draft will land in under 5 minutes.</li>
      </ul>
    </StepShell>
  );
}
