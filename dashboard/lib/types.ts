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
