import { NextResponse } from 'next/server';
import {
  COST_SPIKE_MIN_TRIGGER_USD,
  DRAFT_BACKLOG_THRESHOLD_HOURS,
  evaluateAlerts,
} from '@/lib/alerts';
import {
  getActiveWorkflowCount,
  getCloudSpend24h,
  getCloudSpendLastHour,
  getDiskFree,
  getDraftBacklogAged,
  getDraftCounts24h,
  getEditRate7d,
  getLastEmailReceivedAt,
  getLastError,
  getLastInferenceLatency,
  getN8nFailures24h,
  getOllamaLoadedModels,
  getQdrantCollectionHealth,
  getQueueDepth,
} from '@/lib/queries-system';
import { buildRagEvalSnapshot } from '@/lib/rag/eval-baseline';

export const dynamic = 'force-dynamic';

// GET /api/system/status — STAQPRO-146 / FR-29 (status snapshot) +
// STAQPRO-128 (operator-facing alerts).
//
// Operator-facing health snapshot. Each field falls back to null on
// individual failure (rather than failing the whole response) so the status
// page can render partial data when one upstream — Ollama, Postgres, etc. —
// is unreachable. Response always 200; partial-degradation signal lives in
// the field values.
//
// `alerts` is an array of currently-firing alerts evaluated against the
// thresholds in lib/alerts.ts. Empty array = healthy.
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
    cloudSpend24h,
    draftBacklogAged,
    n8nFailures24h,
    cloudSpendLastHour,
    editRate7d,
    qdrantCollection,
  ] = await Promise.all([
    getQueueDepth().catch(() => null),
    getLastError().catch(() => ({ message: null, at: null })),
    getLastInferenceLatency().catch(() => ({ latency_ms: null, at: null })),
    getLastEmailReceivedAt().catch(() => null),
    getActiveWorkflowCount(),
    getDiskFree('/'),
    getOllamaLoadedModels(),
    getDraftCounts24h().catch(() => null),
    getCloudSpend24h().catch(() => null),
    getDraftBacklogAged(DRAFT_BACKLOG_THRESHOLD_HOURS).catch(() => null),
    getN8nFailures24h(),
    getCloudSpendLastHour(),
    getEditRate7d().catch(() => ({ edit_rate: null, sample_size: 0 })),
    getQdrantCollectionHealth(),
  ]);

  // STAQPRO-192 — wrap the live edit-rate alongside the frozen pre-RAG
  // baseline so the /status page (and any future evaluation tooling) can
  // render a delta directly. The baseline lives as a code constant — see
  // lib/rag/eval-baseline.ts header for the capture protocol.
  const ragEval = buildRagEvalSnapshot(editRate7d.edit_rate, editRate7d.sample_size);

  const alerts = evaluateAlerts({
    draftBacklog: draftBacklogAged,
    n8nFailures: n8nFailures24h,
    cloudCostSpike:
      cloudSpendLastHour !== null && cloudSpend24h !== null
        ? {
            last_hour_usd: cloudSpendLastHour,
            trailing_24h_usd: cloudSpend24h.total_usd,
            min_trigger_usd: COST_SPIKE_MIN_TRIGGER_USD,
          }
        : null,
  });

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
    cloud_spend_24h: cloudSpend24h,
    rag_eval: ragEval,
    qdrant_collection: qdrantCollection,
    alerts,
    generated_at: new Date().toISOString(),
    response_time_ms: Date.now() - startedAt,
  });
}
