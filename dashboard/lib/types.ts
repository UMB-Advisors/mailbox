// SoT for *semantic* types — string-literal enums (DRAFT_STATUSES, DRAFT_SOURCES,
// ClassificationCategory, OnboardingStage) plus the *curated view* interfaces
// the dashboard consumes (Draft, InboxMessage, etc). Each view is an
// intentionally narrower shape than the full DB row in lib/db/schema.ts —
// it's the surface routes/components type against, even though the live
// table has additional columns.
//
// When you need the full DB row shape (e.g., for a kysely insert/update that
// touches columns not in the curated view), import the row alias at the
// bottom of this file (`DraftRow`, `InboxMessageRow`, etc.) — those are
// `Selectable<...>` re-exports of the kysely-codegen output.
//
// String-enum SoT is asserted against the live Postgres CHECK constraints
// by test/schema-invariants.test.ts. Curated views are not asserted against
// the schema; they describe what callers expect, not the full table shape.

import type { Selectable } from 'kysely';
import type {
  ClassificationLog as ClassificationLogRow_,
  Drafts as DraftsRow_,
  InboxMessages as InboxMessagesRow_,
  KbDocuments as KbDocumentsRow_,
  Onboarding as OnboardingRow_,
  Persona as PersonaRow_,
  RejectedHistory as RejectedHistoryRow_,
  SentHistory as SentHistoryRow_,
} from '@/lib/db/schema';

// ── String-literal enums (SoT — asserted against Postgres CHECK constraints) ─

// drafts.status enum (STAQPRO-137). Mirrored against the CHECK constraint in
// migrations/003-evolve-drafts-to-queue-shape-v1-2026-04-27.sql; the
// schema-invariants test asserts they stay in sync.
export const DRAFT_STATUSES = [
  'pending',
  'awaiting_cloud',
  'approved',
  'rejected',
  'edited',
  'sent',
  'failed',
] as const;

export type DraftStatus = (typeof DRAFT_STATUSES)[number];

// drafts.draft_source / sent_history.draft_source enum. The live drafting
// path writes 'local' | 'cloud' (the route taken — see lib/drafting/router.ts);
// the broader set here covers the legacy 'local_qwen3' | 'cloud_haiku' values
// that earlier migrations left in the CHECK constraint and that may still
// appear in older sent_history rows.
export const DRAFT_SOURCES = ['local', 'cloud', 'local_qwen3', 'cloud_haiku'] as const;

export type DraftSource = (typeof DRAFT_SOURCES)[number];

export type ClassificationCategory =
  | 'inquiry'
  | 'reorder'
  | 'scheduling'
  | 'follow_up'
  | 'internal'
  | 'spam_marketing'
  | 'escalate'
  | 'unknown';

export type OnboardingStage =
  | 'pending_admin'
  | 'pending_email'
  | 'ingesting'
  | 'pending_tuning'
  | 'tuning_in_progress'
  | 'live';

// kb_documents.status enum (STAQPRO-148). Mirrored against the CHECK constraint
// in migrations/014-create-kb-documents-and-refs-v1-2026-05-02.sql; the
// schema-invariants test asserts they stay in sync.
export const KB_DOC_STATUSES = ['processing', 'ready', 'failed'] as const;

export type KbDocStatus = (typeof KB_DOC_STATUSES)[number];

// ── Curated view interfaces (the dashboard's consumer-facing surface) ───────

export interface Draft {
  id: number;
  inbox_message_id: number;
  draft_subject: string | null;
  draft_body: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null; // pg returns NUMERIC as string
  status: DraftStatus;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  error_message: string | null;
}

export interface InboxMessage {
  id: number;
  message_id: string;
  thread_id: string | null;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  received_at: string | null;
  snippet: string | null;
  body: string | null;
  classification: string | null;
  confidence: string | null; // pg returns NUMERIC as string
  classified_at: string | null;
  model: string | null;
  created_at: string;
  draft_id: number | null;
}

export interface DraftWithMessage extends Draft {
  message: InboxMessage;
}

export interface ClassificationLog {
  id: number;
  inbox_message_id: number;
  category: ClassificationCategory;
  confidence: number; // REAL — pg returns as number
  model_version: string;
  latency_ms: number | null;
  raw_output: string | null;
  json_parse_ok: boolean;
  think_stripped: boolean;
  created_at: string;
}

export interface SentHistory {
  id: number;
  draft_id: number;
  inbox_message_id: number;
  from_addr: string;
  to_addr: string;
  subject: string | null;
  body_text: string | null;
  thread_id: string | null;
  draft_original: string | null;
  draft_sent: string;
  draft_source: DraftSource;
  classification_category: ClassificationCategory;
  classification_confidence: number; // REAL — pg returns as number
  rag_context_refs: unknown[];
  kb_context_refs: unknown[]; // STAQPRO-148: parallel to rag_context_refs for KB corpus
  sent_at: string;
  created_at: string;
}

export interface KbDocument {
  id: number;
  title: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  chunk_count: number;
  status: KbDocStatus;
  error_message: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  processing_started_at: string;
  ready_at: string | null;
}

export interface RejectedHistory {
  id: number;
  draft_id: number;
  inbox_message_id: number;
  from_addr: string;
  subject: string | null;
  classification_category: ClassificationCategory;
  classification_confidence: number; // REAL — pg returns as number
  draft_original: string | null;
  rejected_at: string;
  created_at: string;
}

export interface Persona {
  id: number;
  customer_key: string;
  statistical_markers: Record<string, unknown>;
  category_exemplars: Record<string, unknown>;
  source_email_count: number;
  last_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Onboarding {
  id: number;
  customer_key: string;
  stage: OnboardingStage;
  admin_username: string | null;
  admin_password_hash: string | null;
  email_address: string | null;
  ingest_progress_total: number | null;
  ingest_progress_done: number;
  tuning_sample_count: number;
  tuning_rated_count: number;
  started_at: string;
  lived_at: string | null;
}

// ── Full DB row shapes (re-exports of kysely-codegen output) ────────────────
//
// Use these when you need a column the curated view doesn't expose. The
// lib/db/schema.ts file is generated by `npm run db:codegen` from the
// canonical schema snapshot; columns added via migration become available
// here automatically once the codegen is re-run.

export type DraftRow = Selectable<DraftsRow_>;
export type InboxMessageRow = Selectable<InboxMessagesRow_>;
export type ClassificationLogRow = Selectable<ClassificationLogRow_>;
export type SentHistoryRow = Selectable<SentHistoryRow_>;
export type RejectedHistoryRow = Selectable<RejectedHistoryRow_>;
export type PersonaRow = Selectable<PersonaRow_>;
export type OnboardingRow = Selectable<OnboardingRow_>;
export type KbDocumentRow = Selectable<KbDocumentsRow_>;
