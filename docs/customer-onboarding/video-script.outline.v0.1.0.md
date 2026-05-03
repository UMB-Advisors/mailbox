# Customer onboarding video — script outline (v0.1.0)

```yaml
target_length: ~6 minutes
audience: small CPG operator, non-technical
tone: warm, calm, no jargon
record_after: STAQPRO-152 wizard ships + screenshots captured
```

> First-pass outline. Each step section mirrors the per-step `.md` template (`docs/customer-onboarding/NN-*.md`). Voiceover lines are placeholders to be tightened against the wizard's `intent` text and the per-step `## Voiceover beats` blocks before recording.

## 1. Welcome (~30s)

- **Hook (10s)**: <!-- VOICEOVER: "Plug in the box, finish six quick steps, and you're done." -->
- **Screen action**: cut from physical appliance plug-in to the dashboard's `/onboarding/welcome` screen.
- **Voiceover script**: <!-- VOICEOVER: 2-3 sentences mirroring `WIZARD_STEPS[0].intent` plus a "we'll cover six things in about ten minutes" beat. -->
- **Transition**: <!-- VOICEOVER: "First, lock the appliance down with a password." -->

## 2. Set admin password (~50s)

- **Hook (10s)**: <!-- VOICEOVER: "This password gates everything Staqs can't see." -->
- **Screen action**: record cursor entering the username + password fields; show the strength meter; click Next; show the brief loading state.
- **Voiceover script**: <!-- VOICEOVER: explain that the password is bcrypt-hashed locally and Staqs cannot recover it; recommend a password manager. -->
- **Transition**: <!-- VOICEOVER: "Now tell the appliance who you are." -->

## 3. Operator profile (~50s)

- **Hook (10s)**: <!-- VOICEOVER: "Three fields and your drafts will already sound like you." -->
- **Screen action**: type a sample first name + brand + signoff into the form; show how the example draft preview (if present) updates.
- **Voiceover script**: <!-- VOICEOVER: explain that all three fields are editable later from the persona settings page; reassure that this is just the starting point — the appliance learns more from the email backfill. -->
- **Transition**: <!-- VOICEOVER: "Quick network check before connecting your inbox." -->

## 4. Network check (~40s)

- **Hook (10s)**: <!-- VOICEOVER: "Five seconds to make sure the box can talk to the internet." -->
- **Screen action**: show the three-row checklist resolving from spinner -> green tick over ~5s.
- **Voiceover script**: <!-- VOICEOVER: explain each row briefly (Gmail / dashboard cert / cloud drafter); call out what to do if any are red (link to remediation in the docs). -->
- **Transition**: <!-- VOICEOVER: "Now let's connect your inbox." -->

## 5. Connect Gmail (~80s)

- **Hook (10s)**: <!-- VOICEOVER: "One Google consent screen and you're connected." -->
- **Screen action**: click Connect Gmail; cut to the Google consent screen; show clicking through "Advanced" past the unverified-app warning; cut back to the wizard's success state.
- **Voiceover script**: <!-- VOICEOVER: walk through the unverified-app warning — what it is, why it appears today, and that the team is working on getting it cleared (STAQPRO-197). Reassure that the appliance only ever asks for read inbox + send mail + read profile permissions. -->
- **Transition**: <!-- VOICEOVER: "Almost done." -->

## 6. You're live (~50s)

- **Hook (10s)**: <!-- VOICEOVER: "That's it — your appliance is live." -->
- **Screen action**: show the success card; cut to the operator's inbox showing the "you're live" confirmation email arriving; cut back to the dashboard queue, empty but waiting.
- **Voiceover script**: <!-- VOICEOVER: explain the 5-minute polling cadence, that the first draft can take up to 5 minutes to appear, and what to do with the queue (approve / edit / reject). -->
- **Transition**: <!-- VOICEOVER: "Let's recap." -->

## Outro (~30s)

- **Recap line**: <!-- VOICEOVER: 2-sentence recap — six steps done, drafts coming in, operator stays in the loop. -->
- **Sign-off CTA**: <!-- VOICEOVER: "If you get stuck on any step, the docs at the link below walk through every screen. We'll see you in the queue." -->
- **Card**: support email + link to `docs/customer-onboarding/README.md` (or its public URL once published).
