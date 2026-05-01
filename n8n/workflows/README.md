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

`legacy/` archives the deactivated NIM-era workflows (kept for reference, not imported).

## Round-trip procedure

### Export (capture current appliance state → repo)

```bash
# Default target: jetson-tailscale (Bob, customer #1)
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
ssh jetson-tailscale 'docker exec -it mailbox-n8n-1 wget -qO- \
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
- Logs: `ssh jetson-tailscale 'docker logs mailbox-n8n-1 --tail 50'`

## Known pitfalls (n8n 1.123.35)

- **Don't** switch to Postgres `Execute Query` for the UPDATE nodes — comma-split bug bites email-body-style content (Pitfall #1).
- Tables qualify as `mailbox.drafts` / `mailbox.inbox_messages` (Pitfall #8).
- **Don't** downgrade Gmail Reply to "On Error: Stop" — must be `continueErrorOutput` so failures populate `error_message` instead of silently dropping (Pitfall #7).
- Sub-workflows that use `executeWorkflowTrigger` should have `active: false`. Activating them emits "no native trigger" cosmetic errors every restart.
- `n8n update:workflow --active=…` is a NO-OP at runtime unless n8n is restarted. The flag persists to the DB but the live runtime keeps the old activation state cached.
- Bcrypt hashes in `.env` (Caddy basic_auth) need `$` → `$$` escaping or docker compose silently truncates them.

See `dashboard/CLAUDE.md` and the project memory note for the wider operational gotchas list.
