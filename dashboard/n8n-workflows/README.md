# n8n Workflows

Companion workflows for the MailBox One dashboard.

## MailBOX-Send

Webhook-triggered workflow that takes an approved/edited draft, sends it via Gmail (threaded reply), and updates `mailbox.drafts` to `sent` (or `failed` with `error_message`).

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

The Postgres SELECT inlines the `draft_id` via `{{ Number($json.body.draft_id) }}` to avoid the n8n 1.123.35 Execute Query comma-split bug (Pitfall #1 / DR-20). Mark Sent / Mark Failed use the Postgres `Update` operation (column-mapped UI), which is comma-safe.

### Importing into n8n 1.123.35

1. n8n UI → **Workflows** → **Import from File** → select `MailBOX-Send.json`.
2. Open each node that has an empty credential field and link the existing credential:
   - **Load Draft / Mark Sent / Mark Failed** → MailBox Postgres credential (the same one used by `MailBOX` and `MailBOX-Drafts`).
   - **Gmail Reply** → existing Gmail OAuth2 credential.
3. Click **Save**, then **Activate** the workflow.

### Smoke-test the webhook

After activation, verify the webhook is reachable from inside the appliance:

```bash
sudo docker exec -it mailbox-n8n-1 wget -qO- \
  --post-data='{"draft_id":999999}' \
  --header='Content-Type: application/json' \
  http://localhost:5678/webhook/mailbox-send
```

Expected (clean 404 — not 500):

```json
{"success":false,"error":"Draft not found, or not in approved/edited status","draft_id":999999}
```

If you get a 500 or the request hangs, check:
- Webhook is **Active** (not just saved)
- Postgres credential is linked on Load Draft / Mark Sent / Mark Failed
- Logs: `sudo docker logs mailbox-n8n-1 --tail 50`

### End-to-end test

1. Pick a real `pending` draft in `mailbox.drafts` (or seed one per the spec's "Test Data Setup").
2. From the dashboard `/queue`, click **Approve**.
3. Watch for the reply email to land in your inbox (threaded into the original).
4. Verify `mailbox.drafts.status` for that row → `sent`, `error_message` is NULL.

If Gmail send fails (token expired, etc.), the row goes to `failed` with the error message in `error_message`. The Failed Sends section in M6 will surface it for retry.

### Known pitfalls (from spec §Pitfalls)

- Don't switch to Postgres `Execute Query` for the UPDATE nodes — comma-split bug bites email-body-style content (Pitfall #1).
- Tables qualify as `mailbox.drafts` / `mailbox.inbox_messages` (Pitfall #8).
- Don't downgrade Gmail Reply to "On Error: Stop" — must be `continueErrorOutput` so failures populate `error_message` instead of silently dropping (Pitfall #7).
