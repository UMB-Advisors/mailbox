export interface WebhookResult {
  success: boolean;
  response?: unknown;
  error?: string;
}

export async function triggerSendWebhook(
  draftId: number,
): Promise<WebhookResult> {
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

    return { success: true, response: await res.json() };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Webhook call failed',
    };
  }
}
