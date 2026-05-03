# Step 5: Connect Gmail

> Wizard route: `/onboarding/email-connect` — see `dashboard/app/onboarding/email-connect/page.tsx`

## What this step does

<!-- VOICEOVER: Authorize the appliance to read your inbox and send replies on your behalf. -->

- <!-- TODO(STAQPRO-132): bullet — what the customer sees (single "Connect Gmail" button -> Google consent screen -> redirect back to wizard) -->
- <!-- TODO(STAQPRO-132): bullet — what the appliance is doing in the background (OAuth dance via per-customer client today / shared Staqs client post-STAQPRO-197; refresh token written into n8n credentials_entity) -->
- <!-- TODO(STAQPRO-132): bullet — what the customer needs to do (click through Google consent; expect "unverified app" warning until STAQPRO-197 ships) -->

## Screenshots

<!-- SCREENSHOT: email-connect-button (initial state, single CTA) -->
<!-- SCREENSHOT: google-consent-screen (annotated — show the unverified-app warning for context) -->
<!-- SCREENSHOT: email-connect-success (return state, "Connected as user@brand.com") -->

## Voiceover beats

<!-- VOICEOVER: hook — "One Google consent screen and you're connected." (10-15 words) -->
<!-- VOICEOVER: action prompt — "Click Connect Gmail and approve the requested permissions." -->
<!-- VOICEOVER: warning — "You may see an 'unverified app' notice — click 'Advanced' then continue. We're working on getting that cleared." -->
<!-- VOICEOVER: transition — "Almost done." -->

## Common questions

<!-- TODO(STAQPRO-132): "What permissions am I granting?" (read inbox / send mail / read profile) / "Why does it say unverified?" (Google App Verification in progress, see STAQPRO-197) / "Can I revoke this later?" (yes — Google account settings) -->

## What to do if it fails

<!-- TODO(STAQPRO-132): consent screen redirect failed -> check OAuth client id env / refresh token write failed -> check n8n container logs -->
