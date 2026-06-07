import { sql } from 'kysely';
import { getKysely } from '@/lib/db';

// MBOX-462 P0 — CRUD for mailbox.job_instances, the per-box enabled/parameterized
// state of Agent Job Templates. The catalog (lib/jobs/catalog) is the SoT for
// which jobs *exist*; this is the SoT for which are *on* on this box and how
// they're tuned. Box-level (no account_id) for v1 — single-tenant appliance.
//
// jsonb `params` follows the repo write convention: sql`${JSON.stringify(x)}::jsonb`
// (mirrors lib/queries-accounts.ts / lib/queries-kb.ts). On read, pg parses
// jsonb back to an object.

export interface JobInstance {
  id: number;
  template_id: string;
  enabled: boolean;
  params: Record<string, unknown>;
  schedule: string | null;
  model: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = [
  'id',
  'template_id',
  'enabled',
  'params',
  'schedule',
  'model',
  'created_by',
  'created_at',
  'updated_at',
] as const;

// Full list for the Jobs surface, stable order by template_id.
export async function listJobInstances(): Promise<JobInstance[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom('job_instances')
    .select(COLUMNS)
    .orderBy('template_id', 'asc')
    .execute();
  return rows as JobInstance[];
}

// One instance by its catalog slug. Null when the template isn't enabled on
// this box yet (no row).
export async function getJobInstance(templateId: string): Promise<JobInstance | null> {
  const db = getKysely();
  const row = await db
    .selectFrom('job_instances')
    .select(COLUMNS)
    .where('template_id', '=', templateId)
    .executeTakeFirst();
  return (row as JobInstance | undefined) ?? null;
}

export interface UpsertJobInstanceInput {
  template_id: string;
  enabled?: boolean;
  params?: Record<string, unknown>;
  schedule?: string | null;
  model?: string | null;
  created_by?: string | null;
}

// Enable + (re)parameterize a template on this box. Idempotent upsert keyed on
// the UNIQUE(template_id) constraint — one instance per template per box (v1).
// On conflict, only the explicitly-provided fields are overwritten (an enable
// toggle never clobbers existing params), and updated_at bumps.
export async function upsertJobInstance(input: UpsertJobInstanceInput): Promise<JobInstance> {
  const db = getKysely();
  const row = await db
    .insertInto('job_instances')
    .values({
      template_id: input.template_id,
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.params !== undefined && {
        params: sql`${JSON.stringify(input.params)}::jsonb`,
      }),
      schedule: input.schedule ?? null,
      model: input.model ?? null,
      created_by: input.created_by ?? null,
      // id / created_at / updated_at take their column defaults.
    })
    .onConflict((oc) =>
      oc.column('template_id').doUpdateSet({
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.params !== undefined && {
          params: sql`${JSON.stringify(input.params)}::jsonb`,
        }),
        ...(input.schedule !== undefined && { schedule: input.schedule }),
        ...(input.model !== undefined && { model: input.model }),
        updated_at: sql<string>`NOW()`,
      }),
    )
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  return row as JobInstance;
}

// Flip just the enabled flag. Returns null when no instance exists for the
// template (caller decides: 404, or upsert to create-then-enable).
export async function setJobInstanceEnabled(
  templateId: string,
  enabled: boolean,
): Promise<JobInstance | null> {
  const db = getKysely();
  const row = await db
    .updateTable('job_instances')
    .set({ enabled, updated_at: sql<string>`NOW()` })
    .where('template_id', '=', templateId)
    .returning(COLUMNS)
    .executeTakeFirst();
  return (row as JobInstance | undefined) ?? null;
}
