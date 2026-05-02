# Onboarding Backfill Runbook v0.1.0

**Status:** v0.1.0 — first version, tracks STAQPRO-193. Validated end-to-end on customer #1 (`dustin@heronlabsinc.com`) before merge.

**Audience:** Operator running the canonical "new customer joins" onboarding step against a freshly-provisioned MailBox appliance.

**Tracks:** STAQPRO-193. Parent track: STAQPRO-122 (M3.5 — RAG over Qdrant).

---

## What this runbook covers

The Gmail Sent backfill seeds the appliance's RAG corpus with the operator's reply history before retrieval (STAQPRO-191) ever runs. Without it, retrieval has zero or near-zero corpus on day 1 and pulls noise. The backfill is **the** customer-#2 onboarding step — every new appliance follows the same path:

1. Customer authorizes Gmail OAuth via n8n (existing creds reused — no new credential surface).
2. Operator runs the backfill command (canonical path: dashboard CLI).
3. Operator validates corpus shape with the post-run query in §4.
4. Operator (optionally) fires `npm run rag:backfill` to embed the seeded rows into Qdrant.

---

## Prereqs

| Item | Why | Where |
|---|---|---|
| Appliance reachable over SSH (`jetson` or `jetson-tailscale`) | Container exec | Direct ethernet 10.42.0.2, or tailnet `mailbox-jetson-01.tail377a9a.ts.net` |
| `mailbox-dashboard` container running | The CLI runs inside the dashboard container | `docker compose ps mailbox-dashboard` |
| `MailBOX-FetchHistory` n8n workflow imported + active | The backfill calls this webhook over docker DNS | `n8n/workflows/MailBOX-FetchHistory.json` |
| Gmail OAuth credential `vEz5mz0uaAtlK8yz` valid | The webhook authenticates via this credential | n8n editor → Credentials → "Gmail account" |
| `MAILBOX_OPERATOR_EMAIL` set in `.env` | Identifies which messages in each thread are "my reply" | `/home/bob/mailbox/.env` |

If any of these are missing, stop and fix first. The backfill cannot recover from a misconfigured webhook or Gmail credential.

---

## Importing the n8n sub-workflow

Until the n8n CLI activation race is resolved (see project conventions), import the workflow JSON manually:

1. Open the n8n editor at `http://192.168.1.45:5678` (LAN-only).
2. Click "Workflows" → "Import from File".
3. Select `/home/bob/mailbox/n8n/workflows/MailBOX-FetchHistory.json`.
4. Activate the workflow (toggle in the top-right).
5. Verify the webhook is registered: `curl http://localhost:5678/webhook/mailbox-fetch-history -X POST -H 'content-type: application/json' -d '{"days_lookback":7,"max_messages":1}'` should return `{ok:true, ...}`.

The workflow takes `{ days_lookback: number, max_messages?: number }` in its body and returns `{ ok, days_lookback, after_date, thread_count, threads }` where each thread is the full Gmail thread shape (`{ id, messages: [{ id, threadId, internalDate, payload: { headers, parts, ... } }] }`).

---

## Running the backfill

### Canonical path (CLI inside the dashboard container)

From the workstation:

```bash
ssh jetson 'cd ~/mailbox && docker compose run --rm mailbox-dashboard \
  npm run onboarding:backfill -- --days 180'
```

This:

1. Calls `MailBOX-FetchHistory` over docker DNS (`http://n8n:5678/webhook/mailbox-fetch-history`).
2. For each returned thread, walks messages chronologically and emits one `(inbound, reply)` pair per outbound message authored by `MAILBOX_OPERATOR_EMAIL`.
3. UPSERTs inbound rows into `mailbox.inbox_messages` (idempotent on `message_id`).
4. UPSERTs reply rows into `mailbox.sent_history` (idempotent on `message_id`, `source = 'backfill'` per migration 011).
5. Logs aggregate counts. Bodies are never logged.

Pass `--embed` to chain the embedding step in the same invocation:

```bash
ssh jetson 'cd ~/mailbox && docker compose run --rm mailbox-dashboard \
  npm run onboarding:backfill -- --days 180 --embed'
```

Otherwise, kick embedding off separately when ready: `npm run rag:backfill`.

### Wizard hook (HTTP)

The same orchestrator is exposed at `POST /api/onboarding/backfill`. The M4 onboarding wizard will call this — until then the CLI is the operator surface. The route inherits Caddy basic_auth via the existing `/dashboard/*` matcher.

```bash
curl -u operator:<password> -X POST https://mailbox.heronlabsinc.com/api/onboarding/backfill \
  -H 'content-type: application/json' \
  -d '{"days_lookback": 180}'
```

Response: `{ ok: true, counts: { threads_seen, pairs_extracted, inbox_upserts, ... }, elapsed_ms }`.

---

## Post-run validation

Confirm the corpus seeded. From the workstation:

```bash
ssh jetson 'docker compose -f ~/mailbox/docker-compose.yml exec -T postgres \
  psql -U mailbox -d mailbox -c "
    SELECT
      (SELECT COUNT(*) FROM mailbox.inbox_messages)         AS inbox_total,
      (SELECT COUNT(*) FROM mailbox.sent_history WHERE source = '\''backfill'\'') AS sent_backfill,
      (SELECT COUNT(*) FROM mailbox.sent_history WHERE source = '\''live'\'')     AS sent_live;
  "'
```

Expected after a 180-day backfill on `dustin@heronlabsinc.com`:
- `inbox_total` increases by hundreds-to-thousands.
- `sent_backfill` is non-zero and roughly tracks the number of (inbound, reply) pairs the orchestrator extracted.
- `sent_live` is unchanged from before the run (live archival path is untouched).

Re-running the same `--days 180` window is a no-op against the already-seeded rows (UPSERT on `message_id`).

If you also ran with `--embed`, validate the Qdrant collection point count:

```bash
ssh jetson 'curl -s http://localhost:6333/collections/email_messages | jq .result.points_count'
```

A value of ≥1 confirms the embedding chain wrote real points. Compare to `inbox_total + sent_backfill + sent_live` from above — embedding may legitimately skip rows with empty bodies.

---

## Idempotency + safety

- **Re-run safe.** UPSERT on `message_id` means re-running the same lookback window is a near-no-op (just re-fetches threads from Gmail). Per Locked Decision #5 there is no cursor table; that's the whole point.
- **Hard cap.** `RAG_BACKFILL_MAX_MESSAGES` env (default 5000) bounds the run. The cap is enforced inside the n8n sub-workflow so a runaway pull never reaches Postgres.
- **PII scrub.** Bodies are scrubbed (US phone, SSN, credit-card-ish 16-digit) inside `buildBodyExcerpt` before they reach Qdrant — original bodies remain untouched in `mailbox.inbox_messages.body` / `mailbox.sent_history.draft_sent` so the operator can see the unscrubbed text in the dashboard.
- **No body in logs.** The orchestrator logs only `message_id`s and aggregate counts. Any error includes the offending `message_id` for debugging but never the body.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `MAILBOX_OPERATOR_EMAIL not set` (CLI) or `error: misconfigured` (HTTP) | Env var missing in the dashboard service | Add `MAILBOX_OPERATOR_EMAIL=dustin@heronlabsinc.com` (or the customer's address) to `/home/bob/mailbox/.env` and `docker compose up -d mailbox-dashboard` |
| `fetch-history responded 404 (non-retry)` | n8n workflow not imported / not active | Re-import `MailBOX-FetchHistory.json` and activate it |
| `fetch-history responded 401` | Gmail OAuth credential expired or scope insufficient | Re-authorize the "Gmail account" credential in the n8n editor; needs `gmail.readonly` or wider (existing inbound creds with `gmail.modify` are sufficient) |
| Counts say `pairs_extracted = 0` despite many threads | `MAILBOX_OPERATOR_EMAIL` doesn't match the From header on any sent message | Verify the value matches what shows in your Gmail "Sent" folder; matching is case-insensitive |
| Qdrant point count stays 0 after `--embed` | Ollama unreachable or `nomic-embed-text:v1.5` not pulled | `docker compose exec ollama ollama list` then `ollama pull nomic-embed-text:v1.5` if missing |

---

## Customer-#1 baseline (to be filled at first run)

After running on `dustin@heronlabsinc.com` with `--days 180`, record here:

- `inbox_total`: TODO
- `sent_backfill`: TODO
- `sent_live`: TODO
- Qdrant `email_messages.points_count` (post-`--embed`): TODO
- Run wall-clock duration: TODO
- Notes: TODO (any timeouts, rate-limit retries, malformed threads)

This row is the baseline customer #2 should match within order-of-magnitude. If customer #2's numbers diverge by ≥10× the cap-tuning question reopens (revisit the cursor-table decision).
