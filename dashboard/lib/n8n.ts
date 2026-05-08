export interface WebhookResult {
  success: boolean;
  response?: unknown;
  error?: string;
}

export async function triggerSendWebhook(draftId: number): Promise<WebhookResult> {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) {
    return { success: false, error: 'N8N_WEBHOOK_URL not configured' };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_id: draftId }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return {
        success: false,
        error: `Webhook returned ${res.status}: ${await res.text()}`,
      };
    }

    // STAQPRO-231 — n8n's MailBOX-Send returns an empty body when the
    // Gmail Reply node throws (the workflow exits before reaching the
    // Respond Success / Respond Failure terminal nodes). Tolerate empty +
    // non-JSON bodies rather than throwing 'Unexpected end of JSON input'
    // — that string was the entire operator-visible error during the
    // 2026-05-08 incident (STAQPRO-271). Real cause lives in n8n's
    // execution_data; surface a hint instead.
    const text = await res.text();
    if (!text) {
      return {
        success: false,
        error:
          'n8n webhook returned empty body — likely an upstream send failure. ' +
          'Check the latest errored MailBOX-Send execution_data for the actual cause ' +
          '(commonly Gmail rate-limit on the Reply node).',
      };
    }
    try {
      return { success: true, response: JSON.parse(text) };
    } catch {
      return {
        success: false,
        error: `n8n webhook returned non-JSON body (truncated): ${text.slice(0, 200)}`,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Webhook call failed',
    };
  }
}
