# MBOX-162 — S1/S2/S3 spike results (v0.1, 2026-05-28)

Evidence for the addendum §6 validation spikes. Per §6, DR-43 and DR-45 stay
**Candidate** until this evidence is reviewed.

## S1 — T2 concurrency benchmark — NOT RUN (blocked on safety)

The harness is built + unit-tested (`dashboard/lib/eval/concurrency-bench.ts`,
`dashboard/scripts/concurrency-bench.ts`, 17 deterministic tests). It was **not
executed on M1** — recon showed the live box cannot safely host the test in its
current state:

- **Memory headroom too low.** Baseline `MemTotal ≈ 7.43 GiB`, `MemAvailable ≈
  1.67 GiB`, swap already ~1.1 GiB in use. The classify step loads
  `qwen3:4b-ctx4k` (2.5 GB) into Ollama *alongside* the resident llama-cpp
  drafter — the exact DR-25 contention pattern that caused 138 llama-cpp
  restarts. With 1.67 GiB free, even serialized load risks taking down Heron's
  live drafter, before concurrency is even tested.
- **No trace set on the box** (eval/ is gitignored, not in the image) — would
  need building from the live DB first.
- **Harness memory metric needs a fix before the verdict is meaningful.**
  `defaultReadUsedMemGiB()` measures host-total-used (`MemTotal − MemAvailable`),
  ~5.8 GiB on a live multi-service box, which cannot map to DR-45's 4.0 GiB
  *model+KV footprint* ceiling → `peak_memory` would false-FAIL regardless of
  whether 3 accounts actually fit. Fix: measure the model+KV delta (e.g. via
  the llama.cpp/Ollama process RSS or a quiesced baseline subtraction), not
  host total.

**Recommended path for a valid S1:** run on a **quiesced** appliance (live
drafting stopped → real downtime window, not just an n8n pause) or on dedicated
idle Jetson hardware, after the harness memory-metric fix. The latency signal
(classify p95 < 5s under 3-account load) is the half that's measurable; the
memory half needs the metric fix to mean anything.

## S2 — Schema migration dry-run — PASS

Candidate migration: `docs/s2-account-id-migration-candidate-v0_1-2026-05-28.sql`
(DRY-RUN artifact — NOT in `dashboard/migrations/`; DR-43 still Candidate).

Dry-run executed against an M1-shaped schema in a throwaway `postgres:17-alpine`
(psql exit 0):

- **Backfill is deterministic.** M1 is single-account today (1,217 inbox /
  239 drafts / 1,218 classify-log / 448 sent rows, one connected mailbox). All
  historical rows backfill to a single seeded `accounts` row — zero ambiguity,
  no manual surgery. **DR-43 kill criterion NOT triggered.**
- **Substantive reshape required:** `inbox_messages` `UNIQUE(message_id)` →
  `UNIQUE(account_id, message_id)`. The same Gmail message can legitimately land
  in two connected inboxes (addressed to founder@ and consulting@); the global
  unique would wrongly reject it. The `/api/internal/inbox-messages` xmax dedup
  must key on `(account_id, message_id)`.
- Verified: composite unique accepts cross-account dup; same-account dup still
  rejected; NOT NULL + FK enforced post-backfill.
- **Out of band:** existing Qdrant `email_messages` points need `account_id`
  added to payload (deterministic → default account; one-shot re-tag, not SQL).

**Verdict: S2 PASS** — DR-43's clean-separation design migrates cleanly; risk is
mechanics (the unique reshape + dedup-key change), not backfill ambiguity.

## S3 — Gmail quota: per-account or per-project — ANSWERED

> Note: live Google docs could not be re-fetched this session (fetch tooling
> failed). Figures below are from stable, long-published Gmail API limits —
> reconfirm exact numbers against the live quota page if precision matters; the
> per-project vs per-user *structure* is the decision-relevant, stable fact.

- **Daily usage quota is PER-PROJECT:** ~1,000,000,000 quota units/day, shared
  across every account authenticated through that GCP project's OAuth client. So
  3 accounts on one appliance/one project draw from the **same** daily pool.
- **Rate limit is PER-USER:** ~250 quota units per user per second (moving
  average). Each connected Gmail account is a distinct user → **independent**
  per-second buckets; no cross-account per-second contention.
- Per-method cost (approx): `messages.list` 5, `messages.get` 5,
  `messages.send` 100, `messages.modify` 5.

**Fan-out re-derivation (3 accounts):** per 5-min cycle per account ≈
`list(5) + ~50×get(5) = 255` units → 3 × 255 = 765/cycle × 288 cycles/day ≈
**220K units/day** against the 1B/day per-project pool = **~0.02%**. Trivially
within budget even though the daily quota is shared.

**Verdict: S3 resolved** — the per-project daily quota is NOT a constraint for
3 accounts; the binding limit is per-user/sec (independent per account, already
covered by the existing per-account rate-limit cooldown machinery). The
accounts-per-appliance cap (NC-31) is S1/memory-bound, not quota-bound.

## Net

- **S2 PASS, S3 resolved** → DR-43 has clean migration evidence; the remaining
  blocker for promoting DR-43/DR-45 is **S1**, which is gated on (a) a harness
  memory-metric fix and (b) a quiesced/idle-hardware run window.
