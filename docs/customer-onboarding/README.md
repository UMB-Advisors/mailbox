# Customer onboarding documentation

## Purpose

Customer-facing onboarding documentation. Mirrors the wizard at `/onboarding/*`. Templates here are filled in alongside the appliance #2 ship (target 2026-05-20).

The wizard is the source of truth for what each step does; these templates are the source of truth for what each step looks like in the help video and the customer-facing knowledge base.

## File map

| Step | Path                                | Wizard route                | Status   |
| ---- | ----------------------------------- | --------------------------- | -------- |
| 1    | `01-welcome.md`                     | `/onboarding/welcome`       | template |
| 2    | `02-password.md`                    | `/onboarding/password`      | template |
| 3    | `03-profile.md`                     | `/onboarding/profile`       | template |
| 4    | `04-network-check.md`               | `/onboarding/network-check` | template |
| 5    | `05-email-connect.md`               | `/onboarding/email-connect` | template |
| 6    | `06-complete.md`                    | `/onboarding/complete`      | template |
| -    | `video-script.outline.v0.1.0.md`    | (all)                       | template |

## Conventions

- `<!-- SCREENSHOT: descriptor -->` placeholders mark image insertion points; the descriptor names the asset (e.g., `welcome-mobile`, `password-error-state`).
- `<!-- VOICEOVER: descriptor -->` placeholders mark video voiceover beats. The first voiceover line in each step doc MUST match the wizard's `intent` field in `WIZARD_STEPS` (`dashboard/lib/onboarding/wizard-stages.ts`) verbatim — no automated check, but worth a manual diff at recording time.
- `<!-- TODO(STAQPRO-132): ... -->` placeholders mark per-step content gaps that need to be filled in before the customer-#2 ship.
- All three placeholder forms are grep-able. CI doesn't enforce any minimum count today; the count is asserted in the quick-task verify step.
- File naming: per-step docs use a stable `NN-slug.md` shape so links are stable; the video script uses Dustin's semver convention (`video-script.outline.vX.Y.Z.md`) so revisions don't overwrite.
