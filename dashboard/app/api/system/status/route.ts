import { NextResponse } from 'next/server';
import {
  getActiveWorkflowCount,
  getDiskFree,
  getDraftCounts24h,
  getLastEmailReceivedAt,
  getLastError,
  getLastInferenceLatency,
  getOllamaLoadedModels,
  getQueueDepth,
} from '@/lib/queries-system';

export const dynamic = 'force-dynamic';

// GET /api/system/status — STAQPRO-146 / FR-29.
//
// Operator-facing health snapshot. Each field falls back to null on
// individual failure (rather than failing the whole response) so the status
// page can render partial data when one upstream — Ollama, Postgres, etc. —
// is unreachable. Response always 200; partial-degradation signal lives in
// the field values.
//
// Caddy gates this behind basic_auth (`/dashboard/*` matcher); no separate
// auth check here. If a public unauthenticated /healthz is ever needed, file
// a separate ticket — that's not 146 scope.

export async function GET() {
  const startedAt = Date.now();

  const [
    queueDepth,
    lastError,
    lastInference,
    lastEmailReceivedAt,
    activeWorkflowCount,
    diskFree,
    ollamaModels,
    draftCounts24h,
  ] = await Promise.all([
    getQueueDepth().catch(() => null),
    getLastError().catch(() => ({ message: null, at: null })),
    getLastInferenceLatency().catch(() => ({ latency_ms: null, at: null })),
    getLastEmailReceivedAt().catch(() => null),
    getActiveWorkflowCount(),
    getDiskFree('/'),
    getOllamaLoadedModels(),
    getDraftCounts24h().catch(() => null),
  ]);

  return NextResponse.json({
    uptime_seconds: Math.round(process.uptime()),
    queue_depth: queueDepth,
    last_error: lastError.message,
    last_error_at: lastError.at,
    last_inference_latency_ms: lastInference.latency_ms,
    last_inference_at: lastInference.at,
    last_email_received_at: lastEmailReceivedAt,
    n8n_workflow_active: activeWorkflowCount,
    disk_free_bytes: diskFree?.free_bytes ?? null,
    disk_total_bytes: diskFree?.total_bytes ?? null,
    ollama_models_loaded: ollamaModels,
    drafts_24h: draftCounts24h,
    generated_at: new Date().toISOString(),
    response_time_ms: Date.now() - startedAt,
  });
}
