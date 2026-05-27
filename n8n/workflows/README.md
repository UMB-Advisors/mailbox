# n8n Workflows — Canonical Source of Truth

The `*.json` files in this directory are the version-controlled exports of the n8n workflows that power the MailBOX appliance. They are the bootstrap input for new appliances (customer #2 onwards) and the drift-check baseline against the running appliance.

**Round-trip is automated** via `scripts/n8n-export-workflows.sh` + `scripts/n8n-import-workflows.sh` (STAQPRO-139).

## Active workflows

| File | n8n ID | Trigger | Role |
|------|--------|---------|------|
| `MailBOX.json` | `C3kG7uKyRgxXpcJv` | Schedule (5 min) | Main pipeline. Polls Gmail, dedupes into `mailbox.inbox_messages`, fires `MailBOX-Classify`. |
| `MailBOX-Classify.json` | `MlbxClsfySub0001` | `executeWorkflow` | Sub-workflow. Runs Qwen3 classify, calls `/api/internal/classification-normalize`, gates against `/api/onboarding/live-gate`, inserts the draft stub, fires `MailBOX-Draft`. |
| `MailBOX-Draft.json` | `MlbxDraftSub0001` | `executeWorkflow` | Sub-workflow. Calls `/api/internal/draft-prompt` → routes local Qwen3 vs Ollama Cloud → calls `/api/internal/draft-finalize` to persist. |
| `MailBOX-Send.json` | `mailbox-send` | Webhook `/webhook/mailbox-send` | Triggered by the dashboard on operator approve. Sends via Gmail Reply, updates `mailbox.drafts.status` → `sent` or `failed`. |
| `MailBOX-Digest.json` | `MlbxDigestSb0001` | Schedule (daily @ `DIGEST_SEND_HOUR_LOCAL`) | MBOX-132. Daily operator digest. GET `/api/internal/digest` (render + send-decision), gate on `should_send`, Gmail send (appliance OAuth), then POST `/api/internal/digest/record` to claim the day in `mailbox.digest_sends`. **Not yet imported/activated on the fleet — import + activate per the procedure below.** |

`legacy/` archives the deactivated NIM-era workflows (kept for reference, not imported).

> **MailBOX-Digest activation (MBOX-132, on-box step):** after `n8n-import-workflows.sh`, re-link the Gmail OAuth2 credential on `MailBOX-Digest` (credential IDs differ per appliance — the JSON ships M1's id), set `DIGEST_SEND_HOUR_LOCAL` / `GENERIC_TIMEZONE` / `DIGEST_SEND_FROM_GMAIL` / `DIGEST_QUEUE_URL` in `.env`, activate the workflow, and restart n8n. It's schedule-triggered like `MailBOX`, so it must be `active=true`. The dashboard's `digest_sends` UNIQUE(sent_on) guard makes a manual test re-fire idempotent.

## Round-trip procedure

### Export (capture current appliance state → repo)

```bash
# Default target: mailbox1 (Bob, customer #1)
./scripts/n8n-export-workflows.sh

# Or another tailnet host:
SSH_HOST=jetson-dustin ./scripts/n8n-export-workflows.sh

# Or run on the appliance itself:
SSH_HOST=local ./scripts/n8n-export-workflows.sh
```

Output is normalized via `jq --sort-keys` with volatile fields (`versionCounter`, `versionId`, `instanceId`, `triggerCount`, etc.) stripped. A re-export against an unchanged appliance produces a no-op diff — useful as a drift detector.

### Import (push canonical state → new appliance)

```bash
SSH_HOST=jetson-dustin ./scripts/n8n-import-workflows.sh
```

After import, on the target appliance:

1. **Re-link credentials** in the n8n UI for each imported workflow (credential IDs differ across appliances):
   - `MailBOX` → Gmail OAuth2 + Postgres
   - `MailBOX-Classify` → Postgres
   - `MailBOX-Draft` → Postgres + Ollama (HTTP Request) + Ollama Cloud (HTTP Request, optional)
   - `MailBOX-Send` → Gmail OAuth2 + Postgres
2. **Activate** the trigger-bearing workflows: `MailBOX` (schedule) and `MailBOX-Send` (webhook). Sub-workflows (`MailBOX-Classify`, `MailBOX-Draft`) **stay inactive** — they're invoked via `executeWorkflow`. (Activating them surfaces "no native trigger" cosmetic noise on every restart.)
3. **Restart n8n** to pick up activation:
   ```bash
   ssh <host> 'cd ~/mailbox && docker compose restart n8n'
   ```
4. **Smoke-test** per the per-workflow sections below.

### When to refresh the canonical JSON

Whenever a workflow is edited in the n8n UI on Bob, run the export script and commit the diff. CI does not currently re-export and check (would require Bob connectivity); manual discipline is the gate today.

## MailBOX-Send

Webhook-triggered. The dashboard's `/api/drafts/[id]/approve` and `/retry` POST `{ draft_id }` to `http://n8n:5678/webhook/mailbox-send`.

### Topology

```
Webhook POST /webhook/mailbox-send  (responseMode: responseNode)
  ↓
Load Draft  (Postgres executeQuery, alwaysOutputData; pulls draft + email by id)
  ↓
If draft loaded?  ── true  → Gmail Reply  ── main  → Mark Sent  → Respond Success {success:true, draft_id, sent_at}
                  │                       └ error → Mark Failed → Respond Failure {success:false, draft_id, error}  (HTTP 502)
                  └── false → Respond Not Found {success:false, error}  (HTTP 404)
```

The Postgres SELECT inlines `draft_id` via `{{ Number($json.body.draft_id) }}` to avoid the n8n 1.123.35 Execute Query comma-split bug (Pitfall #1 / DR-20). Mark Sent / Mark Failed use the Postgres `Update` operation (column-mapped UI), which is comma-safe.

### Smoke-test the webhook

```bash
ssh mailbox1 'docker exec -it mailbox-n8n-1 wget -qO- \
  --post-data="{\"draft_id\":999999}" \
  --header="Content-Type: application/json" \
  http://localhost:5678/webhook/mailbox-send'
```

Expected (clean 404 — not 500):

```json
{"success":false,"error":"Draft not found, or not in approved/edited status","draft_id":999999}
```

If you get a 500 or the request hangs:
- Verify the webhook is **Active** (not just saved).
- Verify Postgres credential is linked on Load Draft / Mark Sent / Mark Failed.
- Logs: `ssh mailbox1 'docker logs mailbox-n8n-1 --tail 50'`

## Known pitfalls (n8n 1.123.35)

- **Don't** switch to Postgres `Execute Query` for the UPDATE nodes — comma-split bug bites email-body-style content (Pitfall #1).
- Tables qualify as `mailbox.drafts` / `mailbox.inbox_messages` (Pitfall #8).
- **Don't** downgrade Gmail Reply to "On Error: Stop" — must be `continueErrorOutput` so failures populate `error_message` instead of silently dropping (Pitfall #7).
- Sub-workflows that use `executeWorkflowTrigger` should have `active: false`. Activating them emits "no native trigger" cosmetic errors every restart.
- `n8n update:workflow --active=…` is a NO-OP at runtime unless n8n is restarted. The flag persists to the DB but the live runtime keeps the old activation state cached.
- Bcrypt hashes in `.env` (Caddy basic_auth) need `$` → `$$` escaping or docker compose silently truncates them.
- **Cross-node values**: never read a value produced by a non-adjacent node via bare `$json.<field>` — use `$('Node').item.json.<field>`. `$json` re-points the instant a node is inserted upstream (this is exactly how MBOX-344 broke every send for 4 days). See the dedicated section below; guarded by `dashboard/test/n8n-expr-lint.test.ts`.

See `dashboard/CLAUDE.md` and the project memory note for the wider operational gotchas list.

## Cross-node `$json` references — use `$('Node').item.json.*`

`$json` always resolves to the **output of the node immediately upstream** on the main
path. The moment another node is inserted on that path, every `$json.<field>` in the
downstream node silently re-points at the new node's output — which usually does not
carry the same fields.

**Rule:** if a node needs a value produced by a node that is **not** its immediate
main-input predecessor, reference it explicitly by node name:

```
{{ $('Load Draft').item.json.message_id }}   ✅ survives a node inserted upstream
{{ $json.message_id }}                        ❌ breaks the moment a node is spliced in
```

**MBOX-344 (2026-05-22 → 2026-05-26, M1 send outage):** the `Acquire Send Lock` Postgres
node (`RETURNING id` only) was inserted between `Load Draft` and `Gmail Reply` (via the
`Lock Acquired?` IF). `Gmail Reply` still read `{{ $json.message_id }}` / `{{ $json.draft_body }}`,
so after the splice `$json` was `{ id }` → both fields went empty → Gmail `400 "Invalid id value"`
→ every approve→send failed for four days. Fix: repoint to `{{ $('Load Draft').item.json.* }}`.
(See also the project MEMORY note "n8n `{{ $json.x }}` refs break silently when a node is
inserted upstream".)

**Automated guard (MBOX-345):** `dashboard/test/n8n-expr-lint.test.ts` runs inside the
`dashboard (typecheck + test)` CI gate. It enforces a FLOOR assertion — MailBOX-Send's
`Gmail Reply` `messageId`/`message` must reference `$('Load Draft')`, never bare `$json` —
plus a general rule that flags any node reading a `$json.<field>` that its sole Postgres
`executeQuery` predecessor provably does not return. Run it pre-deploy via
`scripts/smoke-send-lock.sh` (guarded static pre-check) or directly:

```bash
cd dashboard && npx vitest run test/n8n-expr-lint.test.ts
```
