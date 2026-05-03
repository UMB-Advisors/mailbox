# Step 4: Network check

> Wizard route: `/onboarding/network-check` — see `dashboard/app/onboarding/network-check/page.tsx`

## What this step does

<!-- VOICEOVER: We'll verify the appliance can reach Gmail and the cloud drafter before you connect email. -->

- <!-- TODO(STAQPRO-132): bullet — what the customer sees (3-row checklist: Gmail API / dashboard cert / cloud drafter, each with green-tick or red-X) -->
- <!-- TODO(STAQPRO-132): bullet — what the appliance is doing in the background (HTTPS probes against Gmail discovery doc, the public hostname's cert, and the configured cloud drafter base URL) -->
- <!-- TODO(STAQPRO-132): bullet — what the customer needs to do (wait ~5 seconds; if any check fails, follow the inline fix link before clicking Next) -->

## Screenshots

<!-- SCREENSHOT: network-check-passing (all three rows green) -->
<!-- SCREENSHOT: network-check-cert-failing (dashboard cert row red with remediation hint) -->

## Voiceover beats

<!-- VOICEOVER: hook — "Five seconds to make sure the box can talk to the internet." (10-15 words) -->
<!-- VOICEOVER: action prompt — "Wait for the three green ticks, then tap Next." -->
<!-- VOICEOVER: transition — "Now let's connect your inbox." -->

## Common questions

<!-- TODO(STAQPRO-132): "What if Gmail check fails?" (DNS / firewall / Google outage page) / "What if cert check fails?" (Cloudflare DNS not propagated -> wait 2 minutes) -->

## What to do if it fails

<!-- TODO(STAQPRO-132): per-row remediation table — Gmail / cert / cloud drafter each with diagnostic command + likely cause -->
