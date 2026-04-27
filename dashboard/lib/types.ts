export type DraftStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'edited'
  | 'sent'
  | 'failed';

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

// ── Phase 2 additions (plan 02-02 v2) ───────────────────────────────────

export type ClassificationCategory =
  | 'inquiry'
  | 'reorder'
  | 'scheduling'
  | 'follow_up'
  | 'internal'
  | 'spam_marketing'
  | 'escalate'
  | 'unknown';

export type DraftSource = 'local_qwen3' | 'cloud_haiku';

export type DraftStatusV2 = DraftStatus | 'awaiting_cloud';

export interface ClassificationLog {
  id: number;
  inbox_message_id: number;
  category: ClassificationCategory;
  confidence: string; // pg returns REAL as string for parity
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
  classification_confidence: string;
  rag_context_refs: unknown[];
  sent_at: string;
  created_at: string;
}

export interface RejectedHistory {
  id: number;
  draft_id: number;
  inbox_message_id: number;
  from_addr: string;
  subject: string | null;
  classification_category: ClassificationCategory;
  classification_confidence: string;
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

export type OnboardingStage =
  | 'pending_admin'
  | 'pending_email'
  | 'ingesting'
  | 'pending_tuning'
  | 'tuning_in_progress'
  | 'live';

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
