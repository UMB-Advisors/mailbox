# Step 2: Set admin password

> Wizard route: `/onboarding/password` — see `dashboard/app/onboarding/password/page.tsx`

## What this step does

<!-- VOICEOVER: Pick the password the appliance will use to gate the dashboard and the n8n editor. -->

- <!-- TODO(STAQPRO-132): bullet — what the customer sees (username + password fields, strength meter, confirm field) -->
- <!-- TODO(STAQPRO-132): bullet — what the appliance is doing in the background (bcrypt-hashes locally, writes to mailbox.onboarding, queues a Caddy reload) -->
- <!-- TODO(STAQPRO-132): bullet — what the customer needs to do (pick a password they can remember; this is the only password the appliance keeps) -->

## Screenshots

<!-- SCREENSHOT: password-empty-state (form just loaded, no input yet) -->
<!-- SCREENSHOT: password-too-weak (validation error visible) -->
<!-- SCREENSHOT: password-success (transition state after Next, before redirect) -->

## Voiceover beats

<!-- VOICEOVER: hook — "This password gates everything Staqs can't see." (10-15 words) -->
<!-- VOICEOVER: action prompt — "Pick a strong password and confirm it." -->
<!-- VOICEOVER: transition — "Now let's tell the appliance who you are." -->

## Common questions

<!-- TODO(STAQPRO-132): "What if I lose this password?" (recovery: SSH into appliance + reset script) / "Can I use a password manager?" (yes) -->

## What to do if it fails

<!-- TODO(STAQPRO-132): bcrypt write failed -> Postgres connectivity check / Caddy reload failed -> docker compose restart caddy -->
