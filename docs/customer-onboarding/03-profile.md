# Step 3: Operator profile

> Wizard route: `/onboarding/profile` — see `dashboard/app/onboarding/profile/page.tsx`

## What this step does

<!-- VOICEOVER: Tell us who is signing the email so drafts pick up your name, brand, and signoff. -->

- <!-- TODO(STAQPRO-132): bullet — what the customer sees (first name, brand, default signoff fields with examples) -->
- <!-- TODO(STAQPRO-132): bullet — what the appliance is doing in the background (writes to mailbox.persona.statistical_markers; persona resolver picks these up as the operator-override layer) -->
- <!-- TODO(STAQPRO-132): bullet — what the customer needs to do (fill 3 fields; all are editable later from the persona settings page) -->

## Screenshots

<!-- SCREENSHOT: profile-empty (form layout, all three fields visible, mobile) -->
<!-- SCREENSHOT: profile-filled (example values, e.g., Eric / Heron Labs / "Thanks, Eric") -->

## Voiceover beats

<!-- VOICEOVER: hook — "Three fields and your drafts will already sound like you." (10-15 words) -->
<!-- VOICEOVER: action prompt — "Type your first name, your brand, and how you sign emails." -->
<!-- VOICEOVER: transition — "We'll quickly check the network before connecting your inbox." -->

## Common questions

<!-- TODO(STAQPRO-132): "Can I change these later?" (yes — settings page) / "What's my brand?" (the company name customers see in the From line) -->

## What to do if it fails

<!-- TODO(STAQPRO-132): persona row write failed -> Postgres health check; check `mailbox.persona` row exists for customer_key='default' -->
