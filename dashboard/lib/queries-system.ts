import { statfs } from 'node:fs/promises';
import { sql } from 'kysely';
import { getKysely } from '@/lib/db';

// Per-field helpers for /api/system/status (STAQPRO-146 / FR-29). Each helper
// fails closed: on error, returns null rather than throwing — the status
// endpoint should always return 200 with a partial payload, never 500.

export async function getQueueDepth(): Promise<number> {
  const db = getKysely();
  const r = await db
    .selectFrom('drafts')
    .select((eb) => eb.fn.countAll<string>().as('c'))
    .where('status', 'in', ['pending', 'awaiting_cloud'])
    .executeTakeFirstOrThrow();
  return Number(r.c);
}

export async function getLastError(): Promise<{
  message: string | null;
  at: string | null;
}> {
  const db = getKysely();
  const r = await db
    .selectFrom('drafts')
    .select(['error_message', 'updated_at'])
    .where('error_message', 'is not', null)
    .orderBy('updated_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return {
    message: r?.error_message ?? null,
    at: (r?.updated_at as string | undefined) ?? null,
  };
}

export async function getLastInferenceLatency(): Promise<{
  latency_ms: number | null;
  at: string | null;
}> {
  const db = getKysely();
  const r = await db
    .selectFrom('classification_log')
    .select(['latency_ms', 'created_at'])
    .where('latency_ms', 'is not', null)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return {
    latency_ms: r?.latency_ms ?? null,
    at: (r?.created_at as string | undefined) ?? null,
  };
}

export async function getLastEmailReceivedAt(): Promise<string | null> {
  const db = getKysely();
  const r = await db
    .selectFrom('inbox_messages')
    .select((eb) => eb.fn.max('received_at').as('m'))
    .executeTakeFirstOrThrow();
  return (r.m as string | null) ?? null;
}

// n8n's workflow_entity lives in the `public` schema, outside the kysely-codegen
// scope. Use sql template + raw query rather than expanding the codegen include
// pattern — n8n's schema is upstream-managed and shouldn't be a source of
// kysely types.
export async function getActiveWorkflowCount(): Promise<number | null> {
  const db = getKysely();
  try {
    const r = await sql<{ count: string }>`
      SELECT COUNT(*)::text AS count
      FROM public.workflow_entity
      WHERE active = true
    `.execute(db);
    const row = r.rows[0];
    return row ? Number(row.count) : 0;
  } catch (error) {
    console.error('getActiveWorkflowCount failed:', error);
    return null;
  }
}

export async function getDiskFree(
  path = '/',
): Promise<{ free_bytes: number; total_bytes: number } | null> {
  try {
    const s = await statfs(path);
    return {
      free_bytes: s.bavail * s.bsize,
      total_bytes: s.blocks * s.bsize,
    };
  } catch (error) {
    console.error('getDiskFree failed:', error);
    return null;
  }
}

interface OllamaModel {
  name: string;
  size_vram?: number;
}

export async function getOllamaLoadedModels(): Promise<OllamaModel[] | null> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434';
  try {
    const res = await fetch(`${baseUrl}/api/ps`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: OllamaModel[] };
    return data.models ?? [];
  } catch {
    return null;
  }
}

export interface CloudSpend24h {
  total_usd: number;
  call_count: number;
  by_source: Record<string, { total_usd: number; call_count: number }>;
}

// Cost meter aggregation. Per-call cost is already persisted to
// mailbox.drafts.cost_usd via computeCost() in draft-finalize. No separate
// cloud_calls log table needed — drafts IS the per-call log given each draft
// finalize call is one cloud LLM call. Updated for DR-23 supersession: cloud
// spend covers Ollama Cloud (gpt-oss:120b primary) AND Anthropic (alt-cloud
// when ANTHROPIC_API_KEY is set), grouped by drafts.draft_source.
export async function getCloudSpend24h(): Promise<CloudSpend24h> {
  const db = getKysely();
  const rows = await db
    .selectFrom('drafts')
    .select((eb) => [
      eb.ref('draft_source').as('source'),
      eb.fn.sum<string>('cost_usd').as('total'),
      eb.fn.countAll<string>().as('count'),
    ])
    .where(sql<boolean>`created_at > now() - interval '24 hours'`)
    .where('draft_source', 'is not', null)
    .where('cost_usd', 'is not', null)
    .groupBy('draft_source')
    .execute();

  const result: CloudSpend24h = { total_usd: 0, call_count: 0, by_source: {} };
  for (const row of rows) {
    if (!row.source) continue;
    const usd = Number(row.total ?? 0);
    const count = Number(row.count ?? 0);
    result.by_source[row.source] = { total_usd: usd, call_count: count };
    // Only count rows where the route went CLOUD (not local) toward the
    // cloud-spend meter. Local Qwen3 calls cost $0 (run on-device) and
    // shouldn't show up in the spend meter even if cost_usd was populated.
    if (row.source === 'cloud' || row.source === 'cloud_haiku') {
      result.total_usd += usd;
      result.call_count += count;
    }
  }
  return result;
}

export interface DraftCounts24h {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  rejected: number;
}

export async function getDraftCounts24h(): Promise<DraftCounts24h> {
  const db = getKysely();
  const rows = await db
    .selectFrom('drafts')
    .select((eb) => [eb.ref('status').as('status'), eb.fn.countAll<string>().as('c')])
    .where(sql<boolean>`created_at > now() - interval '24 hours'`)
    .groupBy('status')
    .execute();

  const counts: DraftCounts24h = { total: 0, sent: 0, failed: 0, pending: 0, rejected: 0 };
  for (const row of rows) {
    const c = Number(row.c);
    counts.total += c;
    if (row.status === 'sent') counts.sent = c;
    else if (row.status === 'failed') counts.failed = c;
    else if (row.status === 'pending' || row.status === 'awaiting_cloud') counts.pending += c;
    else if (row.status === 'rejected') counts.rejected = c;
  }
  return counts;
}
