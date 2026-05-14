import { z } from 'zod';
import { ONBOARDING_STAGES } from '@/lib/types';

// Schemas for the n8n-facing internal routes. These accept the exact shapes
// n8n already sends today; tightening here would break the live pipeline.

// POST /api/internal/draft-prompt — { draft_id: number }
export const draftPromptBodySchema = z.object({
  draft_id: z.coerce.number().int().positive(),
});

export type DraftPromptBody = z.infer<typeof draftPromptBodySchema>;

// POST /api/internal/draft-finalize — full payload from n8n's draft sub-workflow.
// `source` mirrors the live drafts.draft_source CHECK constraint values that
// the live code actually writes (the broader CHECK also permits legacy
// `local_qwen3` / `cloud_haiku`, but neither is written by the live path).
export const draftFinalizeBodySchema = z.object({
  draft_id: z.coerce.number().int().positive(),
  body: z.string().min(1, 'body (non-empty string) required'),
  source: z.enum(['local', 'cloud']),
  model: z.string().trim().min(1, 'model (non-empty string) required'),
  input_tokens: z.coerce.number().int().nonnegative().default(0),
  output_tokens: z.coerce.number().int().nonnegative().default(0),
});

export type DraftFinalizeBody = z.infer<typeof draftFinalizeBodySchema>;

// POST /api/internal/classification-prompt — all fields optional (route falls
// back to '' on missing).
export const classificationPromptBodySchema = z.object({
  from: z.string().optional().default(''),
  subject: z.string().optional().default(''),
  body: z.string().optional().default(''),
});

export type ClassificationPromptBody = z.infer<typeof classificationPromptBodySchema>;

// POST /api/internal/classification-normalize — { raw?, from?, to? }.
// `from` / `to` feed the deterministic operator-domain preclass (DR-50).
export const classificationNormalizeBodySchema = z.object({
  raw: z.string().optional().default(''),
  from: z.string().optional(),
  to: z.string().optional(),
});

export type ClassificationNormalizeBody = z.infer<typeof classificationNormalizeBodySchema>;

// POST /api/internal/llm/api/generate — Ollama-shape /api/generate body
// forwarded to the local runtime (ollama or llama.cpp, per
// LOCAL_INFERENCE_RUNTIME). STAQPRO-338 / DR-25.
export const llmGenerateBodySchema = z
  .object({
    model: z.string().trim().min(1, 'model required'),
    prompt: z.string().min(1, 'prompt required'),
    stream: z.literal(false).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    stop: z.array(z.string()).optional(),
    format: z.string().optional(),
    system: z.string().optional(),
    template: z.string().optional(),
  })
  .strip();

export type LlmGenerateBody = z.infer<typeof llmGenerateBodySchema>;

// POST /api/internal/llm/api/chat — Ollama-shape /api/chat body. STAQPRO-338.
export const llmChatBodySchema = z
  .object({
    model: z.string().trim().min(1, 'model required'),
    messages: z
      .array(
        z.object({
          role: z.enum(['system', 'user', 'assistant']),
          content: z.string(),
        }),
      )
      .min(1, 'messages (non-empty array) required'),
    stream: z.literal(false).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    format: z.string().optional(),
  })
  .strip();

export type LlmChatBody = z.infer<typeof llmChatBodySchema>;

// POST /api/internal/inbox-messages — STAQPRO-135 ingest endpoint that
// replaces n8n's `Insert Inbox (skip dupes)` Postgres node. Field shape
// mirrors what n8n's `Extract Fields` set node already produces; tightening
// here would break the live workflow.
export const inboxMessageInsertBodySchema = z.object({
  message_id: z.string().min(1, 'message_id (Gmail message id) required'),
  thread_id: z.string().optional().default(''),
  from_addr: z.string().optional().default(''),
  to_addr: z.string().optional().default(''),
  subject: z.string().optional().default(''),
  // n8n always sends received_at as a string, defaulting to '' when Gmail
  // omits the date. '' would crash the TIMESTAMPTZ insert; coerce to
  // undefined so the route can omit the column from the values clause.
  received_at: z
    .string()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  snippet: z.string().optional().default(''),
  body: z.string().optional().default(''),
  in_reply_to: z.string().optional().default(''),
  references: z.string().optional().default(''),
});

export type InboxMessageInsertBody = z.infer<typeof inboxMessageInsertBodySchema>;

// POST /api/internal/onboarding/advance — STAQPRO-152 wizard step transition.
// Both `from` and `to` are constrained to the live OnboardingStage enum; the
// route then checks them against ALLOWED_TRANSITIONS (lib/onboarding/wizard-stages.ts)
// for the strict adjacent-pair contract. customer_key defaults to 'default'
// since the appliance is single-tenant in v1.
export const onboardingAdvanceBodySchema = z.object({
  from: z.enum(ONBOARDING_STAGES),
  to: z.enum(ONBOARDING_STAGES),
  customer_key: z.string().min(1).default('default'),
});

export type OnboardingAdvanceBody = z.infer<typeof onboardingAdvanceBodySchema>;

// POST /api/internal/gmail-cycle-complete — STAQPRO-226. Reports the size of
// the Gmail Get batch n8n just pulled so the dashboard can advance bootstrap
// state. `messages_returned` is non-negative; 0 is the steady-state empty
// poll case and is what flips bootstrap_complete=true on first install.
export const gmailCycleCompleteBodySchema = z.object({
  messages_returned: z.coerce.number().int().nonnegative(),
});

export type GmailCycleCompleteBody = z.infer<typeof gmailCycleCompleteBodySchema>;
