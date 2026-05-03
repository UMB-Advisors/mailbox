# Step 6: You're live

> Wizard route: `/onboarding/complete` — see `dashboard/app/onboarding/complete/page.tsx`

## What this step does

<!-- VOICEOVER: The appliance is now running. The first draft will hit the queue on the next 5-minute poll. -->

- <!-- TODO(STAQPRO-132): bullet — what the customer sees (success card, countdown to next poll, "Open queue" CTA) -->
- <!-- TODO(STAQPRO-132): bullet — what the appliance is doing in the background (Schedule trigger now polling Gmail every 5 min; sends the "you're live" confirmation email; persona extractor begins backfill ingest) -->
- <!-- TODO(STAQPRO-132): bullet — what the customer needs to do (open the queue, watch for the first draft) -->

## Screenshots

<!-- SCREENSHOT: complete-card (success state with countdown) -->
<!-- SCREENSHOT: complete-confirmation-email (the "you're live" email arriving in their inbox) -->

## Voiceover beats

<!-- VOICEOVER: hook — "That's it — your appliance is live." (10-15 words) -->
<!-- VOICEOVER: action prompt — "Tap Open queue. The first draft lands in under five minutes." -->
<!-- VOICEOVER: closer — "If a question comes in, you'll see the draft here ready to approve, edit, or reject." -->

## Common questions

<!-- TODO(STAQPRO-132): "What if no draft shows up?" (check that Gmail has unread mail; first poll up to 5 minutes) / "Can I undo this?" (yes — flip onboarding stage in support runbook) / "How do I add my brand voice?" (settings -> persona) -->

## What to do if it fails

<!-- TODO(STAQPRO-132): no draft within 10 minutes -> check n8n execution log / "you're live" email never arrived -> check Gmail Sent + send-path probe -->
