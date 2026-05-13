---
plan_number: 02-03
slug: imap-ingestion-watchdog
wave: 3
depends_on: [02-02]
autonomous: false
requirements: [MAIL-01, MAIL-02, MAIL-03, MAIL-04, MAIL-05, MAIL-14]
files_modified:
  - n8n/workflows/01-email-pipeline-main.json
  - n8n/workflows/02-imap-watchdog.json
  - n8n/README.md
  - scripts/n8n-import-workflows.sh
  - docker-compose.yml
---

<review_fixes>
**Applied from 02-REVIEWS.md (codex pass, 2026-04-13):**
- HIGH (thread identity): Previously the workflow set `thread_id` from the current message's own `Message-ID`. That value changes on every reply and is NOT a thread identifier. Fix: store `message_id`, `in_reply_to`, `references` verbatim; derive `thread_id` as the *root* of the References chain (first reference, or own message-id only when References is empty AND In-Reply-To is empty). Reply grouping happens at read time, not at insert time.
- HIGH (MAIL-14 multi-account): Plan now models multiple IMAP accounts explicitly via a per-credential `account_key`. Workflow 01 iterates a config-driven list of `{ account_key, imap_cred_name, smtp_cred_name }` records (rendered from `mailbox.accounts` / n8n env), and every `email_raw` insert carries `account_key`. If MAIL-14 is descoped post-Phase-2 the multi-account loop reduces to a single-record list — code path stays the same.
- HIGH (watchdog correctness): Watchdog now keys off **trigger registration health**, not "last execution finished." It calls the n8n REST API for `/workflows/<id>` and verifies `active=true` + the IMAP trigger node is registered; only then does it sanity-check execution recency with a generous (60-minute) backstop. A quiet inbox no longer trips a false stale.
- MEDIUM (unread-only): Removed `include unread only true`. Workflow now keys idempotency entirely on the `email_raw_message_id_uq` unique index (Plan 02-02). The IMAP node polls `ALL` since last UID checkpoint stored in `staticData.global.lastUid[account_key]`, so messages read in other clients are still ingested.
- Reconciliation with 02-08 dispatch contract: the watchdog and any other plan that needs to invoke n8n workflows uses the n8n internal REST API `POST /rest/workflows/<id>/activate` (read) and `/rest/workflows/<id>/run` (run), authenticated via the `N8N Internal API` credential created in this plan. Plan 02-08's `run-by-name` endpoint is replaced by lookup-by-name → run-by-id using this same path; no new dispatch surface invented.
</review_fixes>

<objective>
Ingest inbound email from the customer's Gmail inbox(es) via the n8n IMAP trigger, persist each message once into `mailbox.email_raw` (with thread headers preserved per D-24 and a derived `thread_id` rooted at the References chain head), and hand the row off to the classification sub-workflow for routing. A watchdog sub-workflow runs every 5 minutes, restarts the main workflow if its trigger is unregistered or has not run within a generous backstop (the n8n IMAP trigger death bug per STATE.md), and emails the operator after two consecutive restart failures. MAIL-14 multi-account is modeled explicitly. n8n workflows are stored as JSON files under `n8n/workflows/` so they are committable and OTA-updatable.
</objective>

<must_haves>
- A real Gmail email delivered to any configured dogfood inbox appears as a row in `mailbox.email_raw` within 90 seconds of delivery (SLA budget: 60s IMAP poll + 30s pipeline)
- The `email_raw` row carries `account_key`, `message_id`, `thread_id` (derived from References root), `in_reply_to`, `references`, `from_addr`, `to_addr`, `cc_addr`, `subject`, `body_text` (extracted from HTML if needed)
- `thread_id` is set from the **first token of the `References` header** (the root of the thread) when present; falls back to `In-Reply-To` value; NULL if neither header exists. Never set from the current `Message-ID`.
- Up to 3 accounts can be configured (MAIL-14). Each account appears as a separate IMAP credential and is iterated by `account_key`. Single-account deployments reduce to a list of one.
- The main workflow triggers a classification sub-workflow (implemented in Plan 02-04) via Execute Workflow node, passing the new `email_raw.id`
- The watchdog sub-workflow is active and runs on a 5-minute cron
- Watchdog freshness check hits the n8n REST API for trigger registration; restarts on `active=false` or unregistered IMAP trigger; only flags "stale" if no execution AND a recently-received-via-fallback test message also fails (or 60-minute backstop). Quiet inboxes do not trigger false stale alerts.
- After 2 consecutive restart failures the watchdog sends an operator email
- Both workflows are committed as JSON files and imported via `scripts/n8n-import-workflows.sh`
- Idempotency relies on `email_raw_message_id_uq` (02-02) — no `unread only` filter; messages read elsewhere are still ingested
</must_haves>

<threat_model>
**ASVS L1, block on HIGH.**

| Surface | Threat | Mitigation | Severity |
|---------|--------|------------|----------|
| Gmail OAuth2 refresh token | Leak via n8n credential export | n8n credentials are encrypted at rest using `N8N_ENCRYPTION_KEY` (Phase 1 env); the workflow JSON files committed here reference credentials by name, NEVER embed token values | High → mitigated |
| Inbound email body | Prompt injection carried downstream to Qwen3 classifier and Claude drafter | Store email body as untrusted `text` in `email_raw`; all downstream prompt templates (Plans 04, 07) treat the body as data inside a fenced `<email>` block, never as instructions. Human-in-the-loop approval gate is the ultimate backstop | High → mitigated in-plan + defense-in-depth downstream |
| Watchdog operator email SMTP creds | Same credential surface as customer SMTP — reuse the customer's own SMTP credential | SMTP credential stored only in n8n encrypted store; watchdog email uses the customer's configured SMTP account | Medium |
| IMAP trigger replay on duplicate `message_id` | Duplicate rows in `email_raw` | Unique index `email_raw_message_id_uq` from Plan 02 ensures idempotency; workflow handles unique-violation by skipping | Low → mitigated |
| PII at rest in `email_raw` | Local storage with no customer-level auth in Phase 2 | Inherits Phase 2 LAN-only trust boundary; documented in SECURITY.md. NVMe LUKS (INFRA-11) is the at-rest-encryption control, applied separately | Medium, deferred (LUKS = Phase 1) |
| n8n workflow file in git | Credential config leakage | Workflow JSON MUST contain no `credentials` inline values. `scripts/n8n-import-workflows.sh` verifies before import | High → mitigated |

No HIGH-severity unmitigated threats.
</threat_model>

<tasks>

<task id="1">
<action>
Create the host-side directory structure for n8n workflows so they are committable and OTA-updatable:

```bash
mkdir -p n8n/workflows
```

Create `n8n/README.md` documenting the workflow export/import contract:

```markdown
# n8n Workflows — MailBox One

Committable workflow definitions for the n8n 2.14.2 container. Import on first boot via `scripts/n8n-import-workflows.sh`; re-import replaces workflows by name.

## Contract
- Each JSON file is a single workflow export from `n8n export:workflow --pretty`.
- Credentials are referenced by **name**, not by **id** — names are created once in the n8n UI (Gmail OAuth2, customer SMTP, Postgres mailbox, Ollama).
- Never commit files containing `"credentials": { ... inline values ... }`.
- Workflow `active: true` flag is preserved by the import script.

## Workflows
| File | Purpose | Trigger |
|------|---------|---------|
| 01-email-pipeline-main.json | Ingest inbound email → email_raw → classify | IMAP trigger |
| 02-imap-watchdog.json | Restart dead IMAP trigger, alert on failure | Cron (every 5 minutes) |
```

Mount `n8n/workflows/` read-only into the n8n container so the import script can read the files from inside. Update the `n8n` service in `docker-compose.yml`:

```yaml
    volumes:
      - n8n_data:/home/node/.n8n
      - ./n8n/workflows:/workflows:ro
```
</action>
<read_first>
  - docker-compose.yml  (current n8n volumes)
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-22 watchdog)
</read_first>
<acceptance_criteria>
- `n8n/workflows/` directory exists
- `n8n/README.md` exists and contains "01-email-pipeline-main.json" and "02-imap-watchdog.json"
- `grep -A 5 'n8n:' docker-compose.yml | grep './n8n/workflows:/workflows:ro'` matches
</acceptance_criteria>
</task>

<task id="2">
<action>
Create `n8n/workflows/01-email-pipeline-main.json` — the main ingestion workflow. Multi-account aware (MAIL-14): the workflow contains one IMAP trigger PER account (named consistently as `Gmail IMAP — <account_key>`) plus a shared post-processing chain. For single-account dogfood deployments there is exactly one IMAP trigger node (`account_key='default'`). Adding a second account is a workflow-edit operation, not a code change.

Node graph (per IMAP trigger fan-in):

1. **IMAP Trigger** (built-in) — credential by name (e.g. `Gmail IMAP — default`), mailbox `INBOX`, poll interval `60` seconds, download attachments `false`, **`include unread only` = FALSE** (review fix: idempotency is enforced by the `email_raw_message_id_uq` index, so reading messages already read in another client is safe and prevents missed mail). Each IMAP trigger node has its own `account_key` baked into the next Set node.
2. **Set: account_key** — adds `{ account_key: '<trigger-specific value>' }` to the item so downstream nodes know which account produced it.
3. **Function: Extract Headers + derive thread_id** — parses headers and derives `thread_id` from the **References root**, falling back to `In-Reply-To`, and only NULL if neither header is present. We do NOT use the current Message-ID as the thread id (review fix):
   ```js
   const h = $json.headers || {};
   const rawRefs = h['references'] || h['References'] || '';
   const referencesStr = Array.isArray(rawRefs) ? rawRefs.join(' ') : String(rawRefs);
   const refTokens = referencesStr.match(/<[^>]+>/g) || [];
   const stripBrackets = (s) => String(s || '').replace(/[<>]/g, '').trim();
   const inReplyToRaw = h['in-reply-to'] || h['In-Reply-To'] || null;
   // Thread id = root of the References chain (first token). If no References,
   // fall back to In-Reply-To. NEVER fall back to the current Message-ID — that
   // value changes per reply and is not a thread identifier.
   const threadRoot = refTokens.length > 0 ? stripBrackets(refTokens[0])
                    : inReplyToRaw ? stripBrackets(inReplyToRaw)
                    : null;
   return [{ json: {
     ...$json,
     in_reply_to: stripBrackets(inReplyToRaw) || null,
     references: referencesStr.trim() || null,
     thread_id: threadRoot,
   }}];
   ```
4. **Function: Normalize Body** — if `$json.text` is empty, strip HTML from `$json.html` using a deterministic function (no external deps). Set `body_text` = stripped text, `body_html` = original html.
5. **Postgres: Insert email_raw** — credential `Postgres Mailbox`, operation `insert`, schema `mailbox`, table `email_raw`, columns mapped:
   - `account_key` ← `{{$json.account_key}}`  *(review fix: MAIL-14)*
   - `message_id` ← `{{$json.messageId}}`
   - `thread_id` ← `{{$json.thread_id}}`  *(now derived from References root, may be NULL)*
   - `in_reply_to` ← `{{$json.in_reply_to}}`
   - `references` ← `{{$json.references}}`
   - `from_addr` ← `{{$json.from}}`
   - `to_addr` ← `{{$json.to}}`
   - `cc_addr` ← `{{$json.cc || null}}`  *(review fix: preserve CC for reply path in 02-07)*
   - `subject` ← `{{$json.subject}}`
   - `body_text` ← `{{$json.body_text}}`
   - `body_html` ← `{{$json.body_html}}`
   - `received_at` ← `{{$json.date}}`
   - **Conflict handling:** `ON CONFLICT (message_id) DO NOTHING RETURNING id` — implemented via the Postgres node's "Upsert" mode keyed on `message_id`. Output `id` for next step.
6. **IF: Row Inserted** — `{{$json.id}}` is truthy (skip duplicates silently).
7. **Execute Workflow: classify-email-sub** — passes `{ email_raw_id: $json.id, account_key: $json.account_key }`. The sub-workflow is implemented in Plan 02-04.

Workflow JSON must be a valid n8n 2.14.2 export. Top-level fields:
```json
{
  "name": "01-email-pipeline-main",
  "active": true,
  "nodes": [ ... ],
  "connections": { ... },
  "settings": { "executionOrder": "v1", "saveExecutionProgress": true },
  "staticData": null,
  "tags": [{"name":"phase-2"}, {"name":"ingestion"}],
  "triggerCount": 1
}
```

Do NOT embed credential values. Use the built-in credential reference format:
```json
"credentials": {
  "imap": { "name": "Gmail IMAP" },
  "postgres": { "name": "Postgres Mailbox" }
}
```
</action>
<read_first>
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-22 IMAP, D-24 thread headers)
  - .planning/REQUIREMENTS.md  (MAIL-02 60s poll, MAIL-04 HTML+plain+threading)
  - dashboard/backend/src/db/schema.ts  (email_raw column names)
</read_first>
<acceptance_criteria>
- `n8n/workflows/01-email-pipeline-main.json` exists and is valid JSON: `python3 -c 'import json,sys; json.load(open("n8n/workflows/01-email-pipeline-main.json"))'` exits 0
- `jq -r '.name' n8n/workflows/01-email-pipeline-main.json` returns `01-email-pipeline-main`
- `jq -r '.active' n8n/workflows/01-email-pipeline-main.json` returns `true`
- `jq '[.nodes[] | select(.type == "n8n-nodes-base.emailReadImap")] | length' n8n/workflows/01-email-pipeline-main.json` returns at least `1` (one trigger per configured account; MAIL-14)
- `jq '[.nodes[] | select(.type == "n8n-nodes-base.postgres")] | length' n8n/workflows/01-email-pipeline-main.json` returns at least `1`
- `jq '[.nodes[] | select(.type == "n8n-nodes-base.executeWorkflow")] | length' n8n/workflows/01-email-pipeline-main.json` returns at least `1`
- `grep -c '"name": "Gmail IMAP' n8n/workflows/01-email-pipeline-main.json` returns at least `1`  (single or multi-account credential prefix)
- `grep -c '"name": "Postgres Mailbox"' n8n/workflows/01-email-pipeline-main.json` returns at least `1`
- `grep -c 'account_key' n8n/workflows/01-email-pipeline-main.json` returns at least `1` (MAIL-14)
- `grep -c 'thread_id' n8n/workflows/01-email-pipeline-main.json` returns at least `1`
- **Negative check (review fix):** `grep -c "h\\['message-id'\\]" n8n/workflows/01-email-pipeline-main.json` returns `0` — the deprecated "thread_id from current Message-ID" pattern is gone.
- **Negative check (review fix):** `jq -r '.nodes[] | select(.type=="n8n-nodes-base.emailReadImap") | .parameters.options.includeOnlyUnreadEmails // false' n8n/workflows/01-email-pipeline-main.json` outputs only `false` — unread-only is OFF on every IMAP trigger.
- **Negative check:** `grep -c '"password"' n8n/workflows/01-email-pipeline-main.json` returns `0` (no inline credentials)
- **Negative check:** `grep -c 'accessToken' n8n/workflows/01-email-pipeline-main.json` returns `0`
</acceptance_criteria>
</task>

<task id="3">
<action>
Create `n8n/workflows/02-imap-watchdog.json` — watchdog sub-workflow. Node graph (review-fixed: freshness check is rooted in trigger-registration health, not "last execution finished", so quiet inboxes do not trip false stales):

1. **Cron trigger** — every 5 minutes.
2. **HTTP Request: Get workflow state** — `GET http://n8n:5678/rest/workflows/<MAIN_ID>` with credential `N8N Internal API`. Returns `{ active, nodes, ... }`. The watchdog parses this to detect:
   - `active === false` → workflow turned off (definite stale, restart).
   - No node of type `n8n-nodes-base.emailReadImap` in the loaded definition → trigger missing, restart and alert.
   - Otherwise: continue to step 3.
3. **Postgres Query: backstop on last execution** — only runs if step 2 looks healthy. Uses a 60-minute backstop window (was 10 minutes — that was the false-stale trigger):
   ```sql
   SELECT MAX(finished) AS last_finished
   FROM public.execution_entity
   WHERE workflow_id = (SELECT id FROM public.workflow_entity WHERE name = '01-email-pipeline-main');
   ```
4. **Function: Detect Stale (revised logic)** — emits `{ stale: true, reason }` only if (a) workflow is inactive, OR (b) IMAP trigger node missing/unregistered, OR (c) last_finished is NULL AND startedAt is NULL AND the workflow was loaded more than 60 minutes ago, OR (d) last_finished is older than 60 minutes AND the IMAP trigger node failed registration health check. A quiet inbox alone is NOT stale.
5. **IF stale** — branches to restart path.
6. **HTTP Request: Deactivate** — `POST http://n8n:5678/rest/workflows/{id}/deactivate` (credential `N8N Internal API`).
7. **HTTP Request: Activate** — `POST http://n8n:5678/rest/workflows/{id}/activate` immediately after.
8. **HTTP Request: Verify Activation** — re-`GET /rest/workflows/<id>` and confirm `active=true` AND the IMAP trigger node is present. On failure, set the next step's failure flag.
9. **Function: Track Failure Count** — reads/writes `staticData.global.watchdogFailures`. Increments on verification failure; resets to 0 on success.
10. **IF `watchdogFailures >= 2`** — branches to alert path.
11. **Email Send** — uses credential `Customer SMTP`, to = `{{ $env.OPERATOR_EMAIL }}` or a workflow parameter, subject `[MailBox One] IMAP trigger stalled`, body mentions reason, last execution timestamp, and failure count. Resets the counter after successful send.

Workflow JSON shape:
```json
{
  "name": "02-imap-watchdog",
  "active": true,
  "nodes": [ ... ],
  "connections": { ... },
  "settings": { "executionOrder": "v1" },
  "staticData": { "global": { "watchdogFailures": 0 } },
  "tags": [{"name":"phase-2"}, {"name":"watchdog"}]
}
```
</action>
<read_first>
  - .planning/phases/02-email-pipeline-core/02-CONTEXT.md  (D-22)
  - .planning/REQUIREMENTS.md  (MAIL-03)
  - n8n/workflows/01-email-pipeline-main.json  (workflow name reference)
</read_first>
<acceptance_criteria>
- `n8n/workflows/02-imap-watchdog.json` exists and is valid JSON
- `jq -r '.name' n8n/workflows/02-imap-watchdog.json` returns `02-imap-watchdog`
- `jq '[.nodes[] | select(.type == "n8n-nodes-base.cron")] | length' n8n/workflows/02-imap-watchdog.json` returns `1`
- `jq '[.nodes[] | select(.type == "n8n-nodes-base.emailSend")] | length' n8n/workflows/02-imap-watchdog.json` returns `1`
- `grep -c 'watchdogFailures' n8n/workflows/02-imap-watchdog.json` returns at least `1`
- `grep -c '01-email-pipeline-main' n8n/workflows/02-imap-watchdog.json` returns at least `1`
- **Negative check:** `grep -c '"password"' n8n/workflows/02-imap-watchdog.json` returns `0`
</acceptance_criteria>
</task>

<task id="4">
<action>
Create `scripts/n8n-import-workflows.sh` — idempotent import script that copies workflow JSON into the running n8n container, runs the n8n CLI import, and verifies none of the files contain inline credential secrets before importing:

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

WORKFLOW_DIR="n8n/workflows"

# Safety gate: reject any file with inline credential secrets
echo "→ Validating workflow JSON files for credential safety..."
if grep -r -l '"password"\|accessToken\|refreshToken\|clientSecret' "$WORKFLOW_DIR"/*.json 2>/dev/null; then
  echo "ERROR: inline credential values found in workflow files above. Refusing to import." >&2
  exit 1
fi

echo "→ Importing workflows into n8n container..."
for f in "$WORKFLOW_DIR"/*.json; do
  name=$(basename "$f")
  echo "   - $name"
  docker compose exec -T n8n n8n import:workflow --input="/workflows/$name"
done

echo "→ Verifying import..."
docker compose exec -T n8n n8n list:workflow | tee /tmp/n8n-workflows.txt
grep -q '01-email-pipeline-main' /tmp/n8n-workflows.txt
grep -q '02-imap-watchdog' /tmp/n8n-workflows.txt

echo "→ Import complete."
```

Make it executable: `chmod +x scripts/n8n-import-workflows.sh`.
</action>
<read_first>
  - n8n/workflows/01-email-pipeline-main.json
  - n8n/workflows/02-imap-watchdog.json
  - docker-compose.yml  (n8n volumes)
</read_first>
<acceptance_criteria>
- `scripts/n8n-import-workflows.sh` exists and is executable (`test -x scripts/n8n-import-workflows.sh`)
- `grep '"password"' scripts/n8n-import-workflows.sh` matches (safety gate present)
- `grep 'n8n import:workflow' scripts/n8n-import-workflows.sh` matches
- `grep 'list:workflow' scripts/n8n-import-workflows.sh` matches
</acceptance_criteria>
</task>

<task id="5">
<action>
Provision the n8n credentials in the running n8n instance via the UI, then run the import script. This is a manual step because Gmail OAuth2 requires a browser redirect.

**Operator steps (document in `n8n/README.md`):**

1. Open `http://<appliance-ip>:5678` in a browser.
2. Create credentials (Settings → Credentials → New). For MAIL-14 (up to 3 accounts), repeat the IMAP and SMTP credentials per account using the `Gmail IMAP — <account_key>` / `Customer SMTP — <account_key>` naming convention. For single-account dogfood, `<account_key>` is `default`:
   - **Gmail IMAP — default** (IMAP type): host `imap.gmail.com`, port `993`, SSL `true`, user = dogfood email address, "Use OAuth2" path or app password depending on Gmail mode. For Phase 2 dogfood in Testing mode (per STATE.md), use OAuth2 with Google Cloud Console's test-user list.
   - **Postgres Mailbox**: host `postgres`, port `5432`, database `${POSTGRES_DB}`, user `${POSTGRES_USER}`, password `${POSTGRES_PASSWORD}`, schema `mailbox`, SSL `disable`.
   - **Customer SMTP — default**: host `smtp.gmail.com`, port `587`, user = same dogfood address, secure `tls`.
   - **N8N Internal API**: generate a personal API key from n8n UI Settings → API → Create API Key; paste into credential.
   - **(MAIL-14, optional)** for each additional account, repeat with a distinct `account_key` suffix. Add a matching IMAP trigger node to `01-email-pipeline-main.json` (clone + change credential name + bake the new `account_key` into the downstream Set node). All IMAP triggers fan into the same email_raw insert chain.
3. Run the import:
   ```bash
   ./scripts/n8n-import-workflows.sh
   ```
4. Re-activate the main workflow if the import does not preserve `active: true`:
   ```bash
   docker compose exec -T n8n n8n update:workflow --active=true --id=<workflow-id>
   ```

Append to `n8n/README.md` under a `## First-time setup` heading.
</action>
<read_first>
  - n8n/README.md
  - .planning/STATE.md  (§Decisions for Gmail OAuth2 Testing mode)
  - scripts/n8n-import-workflows.sh
</read_first>
<acceptance_criteria>
- `n8n/README.md` contains a `## First-time setup` section
- `grep 'Gmail IMAP' n8n/README.md` matches
- `grep 'Postgres Mailbox' n8n/README.md` matches
- `grep 'Customer SMTP' n8n/README.md` matches
- `grep 'N8N Internal API' n8n/README.md` matches
- After running `./scripts/n8n-import-workflows.sh`, `docker compose exec -T n8n n8n list:workflow | grep -c '01-email-pipeline-main'` returns at least `1`
- `docker compose exec -T n8n n8n list:workflow | grep -c '02-imap-watchdog'` returns at least `1`
</acceptance_criteria>
</task>

<task id="6">
<action>
End-to-end smoke test: send a test email from any external account to the dogfood inbox, wait 90 seconds, then confirm a new row appears in `mailbox.email_raw`. Capture the row for use by Plan 02-04 testing.

```bash
# 1. Record baseline row count
BEFORE=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COUNT(*) FROM mailbox.email_raw;")
echo "before: $BEFORE"

# 2. Operator: send a test email to the dogfood Gmail inbox from another account with subject "MailBox Phase 2 smoke"

# 3. Wait up to 120s for the IMAP poll cycle
for i in $(seq 1 12); do
  AFTER=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COUNT(*) FROM mailbox.email_raw;")
  echo "[$i] after: $AFTER"
  if [ "$AFTER" -gt "$BEFORE" ]; then break; fi
  sleep 10
done

# 4. Inspect the latest row
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT id, from_addr, subject, thread_id, in_reply_to, references
  FROM mailbox.email_raw ORDER BY id DESC LIMIT 1;
"
```

Since Plan 02-04 has not landed yet, the Execute Workflow step in the main workflow will log an error ("sub-workflow not found"). That is acceptable for this plan — the `email_raw` row must still be written before the Execute step fires. Plans 02-04 and 02-07 will close the loop.
</action>
<read_first>
  - n8n/workflows/01-email-pipeline-main.json
  - dashboard/backend/src/db/schema.ts
</read_first>
<acceptance_criteria>
- A new row is present in `mailbox.email_raw` after the test send (row count increases by at least 1)
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT from_addr FROM mailbox.email_raw ORDER BY id DESC LIMIT 1;"` is non-empty
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT account_key FROM mailbox.email_raw ORDER BY id DESC LIMIT 1;"` returns `default` (MAIL-14 column populated)
- Thread-grouping spot check (review fix): send a reply from another account to the dogfood inbox referencing the first test, then verify both rows share the same `thread_id`:
  ```
  psql -Atc "SELECT message_id, thread_id, in_reply_to FROM mailbox.email_raw ORDER BY id DESC LIMIT 2;"
  ```
  Both rows MUST have the same `thread_id` (root from References), and the reply's `in_reply_to` MUST match the original's `message_id`. NOT-EQUAL is a regression.
- `docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COUNT(*) FROM mailbox.email_raw WHERE message_id IS NOT NULL AND from_addr IS NOT NULL AND received_at IS NOT NULL;"` is at least `1`
</acceptance_criteria>
</task>

<task id="7">
<action>
Verify the watchdog sub-workflow is active and detects staleness. Manually simulate a stale state by deactivating the main workflow and observing the watchdog behavior on the next 5-minute tick:

```bash
# 1. Confirm watchdog is active
docker compose exec -T n8n n8n list:workflow | grep -E '02-imap-watchdog.*active'

# 2. Deactivate main workflow to simulate a dead trigger
MAIN_ID=$(docker compose exec -T n8n n8n list:workflow | awk '/01-email-pipeline-main/ {print $1}')
docker compose exec -T n8n n8n update:workflow --active=false --id="$MAIN_ID"

# 3. Wait for next watchdog tick (up to 6 minutes)
sleep 360

# 4. Check that main workflow was reactivated by the watchdog
docker compose exec -T n8n n8n list:workflow | grep -E '01-email-pipeline-main.*active'
```

If the reactivation does not happen, inspect the watchdog execution log in the n8n UI and file the issue — this is the failure mode STATE.md flagged as an open blocker.
</action>
<read_first>
  - n8n/workflows/02-imap-watchdog.json
</read_first>
<acceptance_criteria>
- After simulated deactivation + wait cycle, `docker compose exec -T n8n n8n list:workflow | grep -c '01-email-pipeline-main.*active'` returns at least `1`
- n8n UI execution log shows at least one watchdog execution during the wait window
</acceptance_criteria>
</task>

</tasks>

<verification>
```bash
# 1. Both workflows imported and active
docker compose exec -T n8n n8n list:workflow | tee /tmp/wf.txt
grep -q '01-email-pipeline-main' /tmp/wf.txt
grep -q '02-imap-watchdog' /tmp/wf.txt

# 2. Workflow JSON files committable (no inline credentials)
! grep -r -l 'password\|accessToken\|refreshToken' n8n/workflows/*.json

# 3. Test email lands in mailbox.email_raw within 90s (measured in task 6)
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT COUNT(*) FROM mailbox.email_raw WHERE subject LIKE '%smoke%';
" | grep -q -v '^0$'

# 4. Watchdog recovered a simulated dead trigger (measured in task 7)
# (manual verification — recorded in n8n execution log)

# 5. email_raw row shape includes thread headers per D-24
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "
  SELECT COUNT(*) FROM mailbox.email_raw
  WHERE message_id IS NOT NULL AND received_at IS NOT NULL;
" | grep -vq '^0$'
```
</verification>
