import { NextResponse } from 'next/server';
import {
  COST_SPIKE_MIN_TRIGGER_USD,
  DRAFT_BACKLOG_THRESHOLD_HOURS,
  evaluateAlerts,
} from '@/lib/alerts';
import { checkMemoryPressure } from '@/lib/preflight/memory';
import { checkSwap, type SwapResult } from '@/lib/preflight/swap';
import { type GitState, getGitStateWithTimeout } from '@/lib/queries-git';
import { findOrphanContainers, type OrphanResult } from '@/lib/queries-orphans';
import {
  getActiveWorkflowCount,
  getCloudSpend24h,
  getCloudSpendLastHour,
  getDiskFree,
  getDraftBacklogAged,
  getDraftCounts24h,
  getEditRate7d,
  getJobHealth,
  getLastEmailReceivedAt,
  getLastError,
  getLastInferenceLatency,
  getN8nFailures24h,
  getOllamaLoadedModels,
  getQdrantCollectionHealth,
  getQueueDepth,
} from '@/lib/queries-system';
import { checkUpdateAvailability, type UpdateAvailability } from '@/lib/queries-update';
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
    jobHealth,
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
    getJobHealth().catch(() => null),
  ]);

  // MBOX-163 — appliance git state (branch / sha / behind-master / dirty /
  // fetch age). Reads via execFile from the bind-mounted repo at
  // $MAILBOX_REPO_MOUNT (default /app/repo, see docker-compose.yml). The
  // helper bounds itself with a 500ms ceiling and clears the loser timer
  // so we don't leave dangling setTimeouts on each /status request — see
  // getGitStateWithTimeout in lib/queries-git.ts.
  const gitState: GitState = await getGitStateWithTimeout(500);

  // STAQPRO-192 — wrap the live edit-rate alongside the frozen pre-RAG
  // baseline so the /status page (and any future evaluation tooling) can
  // render a delta directly. The baseline lives as a code constant — see
  // lib/rag/eval-baseline.ts header for the capture protocol.
  const ragEval = buildRagEvalSnapshot(editRate7d.edit_rate, editRate7d.sample_size);

  // MBOX-166 / MBOX-109 — memory pressure stat. Synchronous /proc/meminfo
  // read; helper is total-failure-safe (returns red on read/parse error,
  // never throws), so no try/catch needed.
  const memory = checkMemoryPressure();

  // MBOX-168 — swap-in-use stat. Same total-failure-safe contract as
  // memory_pressure; synchronous /proc/meminfo read.
  const swap: SwapResult = checkSwap();

  // MBOX-168 — orphan-container detector. Calls the docker socket + reads
  // the compose file off the MBOX-163 bind mount. Bound at 800ms total via
  // Promise.race (the helper itself bounds each docker call at 500ms, but
  // a hung fs read on a degraded volume could outlast that — mirror the
  // git_state bound).
  const orphans: OrphanResult = await Promise.race<OrphanResult>([
    findOrphanContainers(),
    new Promise<OrphanResult>((resolve) =>
      setTimeout(
        () =>
          resolve({
            status: 'red',
            orphan_count: 0,
            orphan_names: [],
            expected_names: [],
            reason: 'orphan_containers check timed out (>800ms)',
          }),
        800,
      ),
    ),
  ]);

  // MBOX-184 — read-only OTA "Update available" detection. Same bounded,
  // total-failure-safe pattern as the orphan check (manifest read off the
  // MBOX-163 repo bind + one MBOX-168 docker.sock call). Read-only; the
  // "Update now" action is a deferred follow-up.
  const updates: UpdateAvailability = await Promise.race<UpdateAvailability>([
    checkUpdateAvailability(),
    new Promise<UpdateAvailability>((resolve) =>
      setTimeout(
        () =>
          resolve({
            update_available: false,
            services: [],
            reason: 'update_available check timed out (>800ms)',
          }),
        800,
      ),
    ),
  ]);

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
    memoryPressure: {
      status: memory.status,
      memAvailableGiB: memory.memAvailableGiB,
      minMemGiB: memory.minMemGiB,
    },
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
    jobs: jobHealth,
    memory_pressure: {
      status: memory.status,
      mem_available_gib: memory.memAvailableGiB,
      min_mem_gib: memory.minMemGiB,
      reason: memory.reason,
    },
    swap_in_use: swap,
    orphan_containers: orphans,
    ota_updates: updates,
    alerts,
    git_state: gitState,
    generated_at: new Date().toISOString(),
    response_time_ms: Date.now() - startedAt,
  });
}
