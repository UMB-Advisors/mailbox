# Deferred Items — Phase 5

Out-of-scope discoveries logged during plan execution (not fixed, per the executor's
scope-boundary rule — only issues directly caused by the current task's changes are
auto-fixed).

## 05-01

- **`gsd-tools query state.update-progress` did not bump `completed_plans` after
  `05-01-SUMMARY.md` landed.** Ran twice after the SUMMARY existed (with `status: complete`
  frontmatter); both times returned `completed: 11, total: 23` — unchanged from before the
  plan started. Direct unit-level check (`plan-scan.cjs` run standalone against
  `.planning/phases/05-backend-data-model-auto-create/`) correctly reports
  `planCount: 4, summaryCount: 1`, so the per-phase scan itself is fine — the discrepancy
  looks like it's in `getMilestonePhaseFilter`'s directory-inclusion logic for the
  current milestone (M5, phases 5-8), not in this plan's artifacts. Pre-existing GSD
  tooling behavior, unrelated to any file this plan touched — not investigated further.
  `state begin-phase`, `state advance-plan`, `state record-metric`, `state add-decision`,
  and `state record-session` all worked correctly and were used to update STATE.md
  manually-equivalent fields.
