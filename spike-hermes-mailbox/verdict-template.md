# Verdict — Hermes on an Existing MailBOX Appliance (spike v0.1)

> Fill at end of Day 3. One page. Drops into the Eric/Kevin briefing and is
> recorded back into `addendum-agentbox-solo-hermes-mailbox` once that exists.

**Date:** ____  **Operator:** ____  **Bench box:** ____ (NOT a customer box)
**Hermes:** v____  **gbrain:** v____ (engine: pglite | postgres)  **Cloud model (both arms):** ____

## 1. Verdict

> **GREEN** (fits + improves drafts) · **AMBER** (fits, draft value unproven) · **RED** (does not fit)

**→ ____**

## 2. SM-97 — memory fit (Q1, the hard gate)

| State | Peak RAM used | Free at peak | Notes |
|---|---|---|---|
| S0 baseline | ____ MB | ____ MB | |
| S1 pipeline busy | ____ MB | ____ MB | |
| **S2 worst case** | ____ MB | **____ MB** | the gate |

- **Q1 verdict:** PASS / MARGINAL / FAIL  (≥500 / 200–500 / <200 MB or OOM)
- Classifier-drop variant (if run, §4.5): free at peak ____ MB → ____
- Evidence: `out/S2-tegrastats.log`

## 3. NC-41 — draft value (Q2)

| Arm | send-as-is | minor-edit | rewrite | n | mean latency |
|---|---|---|---|---|---|
| A (direct cloud) | ____% | | | | ____ ms |
| B (Hermes + gbrain) | ____% | | | | ____ ms |

- **Δ (B − A):** ____ pp  → **decision:** Hermes IN / NOT-worth / OUT of draft path
- Voice fidelity (qualitative): where did B sound materially more "like me"? ____
- Confounds (e.g., arm models not identical): ____

## 4. NC-40 observation (free, while we were in there)

Hermes native security behavior on the bench (PII redaction before cloud calls?
tirith pre-exec scan? approval escalation?): ____  *(record, don't decide)*

## 5. Recommendation (SKU shape)

> GREEN → T2-with-Hermes · AMBER → T2-conversational-only + T3-full · RED → T3-only Hermes

**→ ____**

- gbrain storage if productized: PGlite (isolated) vs shared pg17 + pgvector
  (footprint lever) — recommendation: ____
