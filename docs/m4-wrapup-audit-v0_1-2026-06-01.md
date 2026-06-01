# M4 — Phase 2 (RAG + edit-to-skill): Wrap-Up Audit (v0.1, 2026-06-01)

> Method: each Delivered M4 issue was independently verified against the live codebase
> (PRs, commits, file contents) and its Linear acceptance criteria + operator comments by a
> dedicated verifier agent, with an adversarial second-pass on every non-CONFIRMED verdict.
> Mirrors the structure of `docs/m5-wrapup-audit-v0_1-2026-05-28.md`.

## TL;DR

M4 ("Phase 2 — RAG + edit-to-skill") is **closable after a small set of Linear hygiene moves**, not blocked on real engineering. Linear reads 100% (12 tagged: 9 Delivered, 3 dead Duplicates), and that figure is **largely honest** — unlike M5's inflated count. Two of the three charter pillars are accounted for off-milestone: **RAG shipped in M3.5** (MBOX-223 + children, all Delivered) and **multi-pack orchestration was re-milestoned to M6** (MBOX-43, Backlog, explicitly deferred). The two research spikes (MBOX-118 style-vectors, MBOX-120 constrained decoding) are **legitimately SPIKE_CLOSED** — substantive prototypes + decision memos landed, on-device productization correctly deferred as hardware-gated. The **one genuine soft spot** is the edit-to-skill pillar: **MBOX-186 is marked Delivered but is PARTIAL** — the capture half (original-draft snapshotting) genuinely shipped, but the headline value ("learns the customer's voice from edits") is unbuilt; the captured delta has zero read-side consumer. The synthesis work already has a home — **MBOX-187, currently unmilestoned + Backlog** — so the honest fix is a split + re-milestone, not a reopen of a closable milestone.

## 1. What M4 Delivered (CONFIRMED)

Grouped by the three Phase-2 charter pillars.

### Pillar A — RAG over Qdrant (relationship graph)
**Delivered elsewhere — out of M4's remaining scope.** RAG was pulled *forward* into its own milestone **M3.5** and shipped there: umbrella **MBOX-223** ("RAG corpus / Qdrant integration (Phase 2)") plus 5 children, all Delivered. M4 carries the *placeholder* (MBOX-41 stub-preservation) and the *consumer* surfaces that depend on RAG, but the corpus/retrieval build itself is not an M4 line item. Counting it against M4's remaining work would double-count M3.5.

### Pillar B — Edit-to-skill learning loop
- **MBOX-186 (PARTIAL — see §2)** — Capture-side genuinely shipped: migration `012-add-original-draft-body-for-edit-deltas` adds `drafts.original_draft_body`, the edit route (`dashboard/app/api/drafts/[id]/edit/route.ts:32`) populates it via `COALESCE(original_draft_body, draft_body)` (first-snapshot-wins), and the archive trigger rewires `draft_original = COALESCE(...)`. The per-row original-vs-sent delta is real, not a stub. The **synthesis half is not built** — see §2.
- **MBOX-257 CONFIRMED** — Persona settings UI (FR-33). Real route `dashboard/app/settings/persona/page.tsx` → `PersonaSettings.tsx` (210 lines: metadata strip + two validated JSON editors + Save + "Refresh from sent history"), writes operator overrides to `mailbox.persona` via `PUT /api/persona` → `upsertPersona()` (Kysely upsert on `customer_key`). Migration `005-create-persona`. PR #21, 3 DB-backed vitest cases, zero operator-dispute comments.
- **MBOX-258 CONFIRMED** — Persona extraction from sent history (Build Plan 02-06). `dashboard/lib/persona/extract.ts` — pure heuristic over `sent_history` (sentence length, formality 0..1, sign-offs/greetings, top-10 bigrams, per-category markers). Three-layer resolver `resolvePersonaContext` (override → extraction → fallback). PR #22, 18 vitest cases. On-appliance-only privacy honored.

### Pillar C — Multi-pack orchestration
**Re-milestoned to M6 — explicitly deferred, not M4-blocking.** **MBOX-43** ("[M4] Multi-pack orchestration") sits in Backlog as a child of MBOX-41; the work was consciously pushed to M6. It is a placeholder, not an unmet acceptance item against M4.

### Supporting deliverables (operator surfaces + scope scaffolding)
- **MBOX-263 CONFIRMED** — Operator visibility views (FR-27). Sent-history folder slices (PR #12) + classification-log view `dashboard/app/classifications/page.tsx` with all three filters (category/route/confidence) and `deriveRoute()` (PR #16). The only unbuilt item (inline "misclassified" button) was explicitly Optional and was independently delivered later via MBOX-123/MBOX-368.
- **MBOX-268 CONFIRMED** — Knowledge base upload UI (FR-32). All 5 acceptance criteria are real code: upload page + chunker/parsers/ingest (`dashboard/lib/rag/kb-*.ts`), migration `014-create-kb-documents-and-refs`, embed via nomic-embed-text, list/view/delete/retry routes, and per-draft KB audit (`drafts.kb_context_refs`). PR #33; live end-to-end upload verified on M1.
- **MBOX-41 CONFIRMED** — Stub-issue scaffolding (admin/doc). 5 stubs created (STAQPRO-169..173); a same-day dedup pass closed 169/170/171 as duplicates of pre-existing RAG/edit-to-skill tickets, kept 172/173 net-new. Sound housekeeping, not scope loss.
- **MBOX-42 CONFIRMED** — Phase-2 entrance criteria doc. `docs/runbook/phase-2-entrance-criteria.v0.1.0.md` (186 lines): 7 objective gates each with metric source + numeric target + measurement SQL, plus a filled "Today's snapshot" PASS/FAIL table answering "start Phase 2 now? → NOT MET." PR #79. The doc self-flags 4/7 gates as UNKNOWN pending continuous-measurement infra — explicitly out of scope for a *define-the-gate* doc.

### Research spikes (SPIKE_CLOSED — a legitimate done state)
- **MBOX-118 SPIKE_CLOSED** — Style-vector / activation-steering spike. Off-device deliverables (the spike's actual scope) all landed via PR #179 (merged `3242405`): real prototype `optimization/style-vectors/` (extract/steer/eval/cli), 18/18 green tests, and decision memo `docs/memo-style-vectors-vs-lora-v0_1-2026-05-28.md`. Operator's own close-out comment frames the on-device T2 t/s number as deliberately **out of spike scope and hardware-gated**, not a gap.
- **MBOX-120 SPIKE_CLOSED** — Constrained-decoding spike (negative result). GBNF grammars + dispatch (default OFF) + A/B harness + decision memo landed (PR #183 `00f0ada`, plus #190/#193 and the `@umb-advisors/llm` grammar passthrough). The on-device A/B was **actually run on M1**: constrained generations degraded (degenerate filler, ~3× latency), so the operator shipped the flag OFF and recorded "revisit only with EOS-enforcing grammars." A well-supported negative result is a closed spike, not a failure.

## 2. False / Partial Completes

| Issue | Verdict | What's missing (evidence) |
|---|---|---|
| **MBOX-186** | **PARTIAL** (marked Delivered) | Acceptance bullet (1) **capture** shipped (migration 012; edit route populates `original_draft_body`). Bullets (2) **synthesis of original-vs-sent deltas into persona/style or few-shot** and (3) **feed edit-derived signal back into the draft prompt** are **not built** anywhere on any branch — `git log --all` shows exactly one feature commit (`a96d422`, PR #27) and it is capture-only; grep for `synthes\|edit.delta\|style.update\|few.shot` across `dashboard/lib,app,scripts` finds no synthesis/delta-stats code. The only feedback-into-drafting path, `dashboard/lib/drafting/exemplars.ts`, reads `draft_sent` (final body) filtered only on `classification_category ORDER BY sent_at DESC` — it **never reads `draft_original`/`original_draft_body`** and landed 4 days *after* MBOX-186's completedAt. Net: the captured edit-delta is **dead data with zero read-side consumer**; the headline "learns the customer's voice from edits" value does not exist. Corroborated by the Linear description ("Synthesis pipeline not yet built") and PR #27's own "Out of scope (deferred to STAQPRO-196): synthesis layer." Zero operator-dispute comments — this was an *intended* slice boundary, mislabeled Delivered for the whole loop. |

This is the only credibility risk in M4, and it is **soft**: the capture prerequisite genuinely shipped, the deferral was documented at merge time, and the missing synthesis already has a fully-scoped home ticket (**MBOX-187**, see §4). Contrast with M5's MBOX-212, which was an empty-template FALSE_DELIVERED with an operator "not complete" dispute — M4 has no equivalent.

## 3. Genuine Remaining Work

**None that gates M4.** Every load-bearing acceptance item in the milestone is either built (§1) or is a documented, reasonable deferral:
- MBOX-258 sub-item (5) "refresh weekly" — manual/on-demand refresh shipped; cron explicitly deferred ("cron when a recurring need surfaces"). Non-load-bearing to the extraction deliverable.
- MBOX-257 bullets (3)/(4) good/bad-draft marking + few-shot trainer — explicitly routed to STAQPRO-121 (edit-to-skill) in PR #21's "Out of scope." Core FR-33 (view+edit persona) fully met.
- MBOX-118/120 on-device productization — out of spike scope, hardware-gated.

The single piece of *genuine unbuilt work* (MBOX-186 synthesis) is **not an M4 line item once split out** — it becomes MBOX-187, which is a Backlog follow-up, and the right call is to **re-milestone it to where the edit-to-skill productization actually lands (M6)**, mirroring how multi-pack orchestration (MBOX-43) was handled.

## 4. Scope Corrections

### Cosmetic — title/milestone mismatch
| Issue | Issue says | Reality | Fix |
|---|---|---|---|
| **MBOX-118** | Title prefix "M5:" | `projectMilestone` = "M4 — Phase 2", parent MBOX-111 | Strip the "M5:" title prefix (or leave — it is purely cosmetic; the milestone field is authoritative and correct) |
| **MBOX-120** | Title prefix "M5:" | `projectMilestone` = "M4 — Phase 2", parent MBOX-111 | Same |

Both verified live in Linear: status Delivered, milestone M4, only the title string carries a stale "M5:". Harmless to the count; worth fixing so a reader scanning titles is not misled.

### Mis-milestoned follow-up — needs a home
| Issue | Current | Target | Why |
|---|---|---|---|
| **MBOX-187** ("Edit-to-skill synthesis layer") | Unmilestoned + Backlog, parent MBOX-186 | **M6** (with the rest of the edit-to-skill / draft-quality productization) | This is the unbuilt synthesis half of MBOX-186. It is fully scoped (delta extractor in `lib/persona/edit-deltas.ts`, persona-refresh integration, prompt feedback, vitest + smoke). Leaving it unmilestoned hides the only real M4 gap. It is **not** M4-blocking — the capture prerequisite shipped — so milestone it forward rather than holding M4 open for it. M6 mirrors the multi-pack (MBOX-43) deferral pattern. |

### Dead duplicates (no action — already correct)
STAQPRO-169/170/171 were closed as Duplicates (folded into MBOX-41's RAG/edit-to-skill scopes which resolve to MBOX-223 and MBOX-186). No reopen needed.

### ALREADY_DONE → mark Delivered
None. No open M4 issue was found to be silently complete.

## 5. Recommended Linear Close-Out Action List

| Issue | Current state | Recommended action | Why |
|---|---|---|---|
| **MBOX-186** | Delivered | **Split: keep capture-side Delivered; move synthesis to MBOX-187.** Edit the description/close-out comment to scope the Delivered claim to capture only. | Honest accounting — the loop's synthesis half is unbuilt; the captured delta has no reader. Do *not* reopen (capture genuinely shipped + was an intended slice boundary). |
| **MBOX-187** | Unmilestoned, Backlog | **Assign milestone M6; keep Backlog.** | It is the unbuilt synthesis follow-up to MBOX-186. Milestoning it surfaces the real gap and prevents it from being lost; M6 is where edit-to-skill productization belongs. |
| **MBOX-118** | Delivered (title "M5:") | **Keep Delivered; optionally strip "M5:" title prefix.** | Spike legitimately closed (off-device deliverables + memo); milestone field already correct at M4. Title-only cosmetic. |
| **MBOX-120** | Delivered (title "M5:") | **Keep Delivered; optionally strip "M5:" title prefix.** | Negative-result spike legitimately closed with a real on-M1 A/B; milestone already M4. Title-only cosmetic. |
| **MBOX-257 / 258 / 263 / 268 / 41 / 42** | Delivered | **Keep Delivered.** | All CONFIRMED with real code/docs and no operator dispute. |
| STAQPRO-169/170/171 | Duplicate (closed) | **No action.** | Correct dedup into MBOX-41 / MBOX-223 / MBOX-186. |

## 6. Go / No-Go Verdict

**GO on closing M4 — conditional on the two-line hygiene fix** (split MBOX-186's synthesis into MBOX-187 and milestone MBOX-187 to M6). Optionally strip the stale "M5:" prefixes on 118/120.

Unlike M5, M4's charter is materially complete: RAG (Pillar A) shipped in M3.5, both spikes closed honestly, the persona/visibility/KB surfaces are real and live on M1, and multi-pack (Pillar C) was a deliberate M6 deferral. The *only* substantive incompleteness is the synthesis half of the edit-to-skill loop — and that work is already captured, scoped, and waiting in MBOX-187. Re-milestoning it forward is the correct, honest way to close M4 without pretending a half-built loop is whole.
