// Wire types for the LLM runtime abstraction (STAQPRO-338 / DR-25).
//
// The n8n workflows and the dashboard's draft-finalize route both expect
// Ollama's request/response envelopes. When LOCAL_INFERENCE_RUNTIME=llama-cpp
// the proxy translates between Ollama shapes (external) and llama.cpp shapes
// (internal). Stream-mode is intentionally not supported — every call site
// in the appliance uses stream:false.

export type RuntimeKind = 'ollama' | 'llama-cpp';

// ── Ollama /api/generate (classify path) ────────────────────────────────

export interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream?: false;
  options?: Record<string, unknown>;
  stop?: readonly string[];
  format?: 'json' | string;
  system?: string;
  template?: string;
}

export interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  response: string;
  done: true;
  done_reason?: string;
  context?: readonly number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

// ── Ollama /api/chat (draft path) ───────────────────────────────────────

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: readonly OllamaChatMessage[];
  stream?: false;
  options?: Record<string, unknown>;
  format?: 'json' | string;
}

export interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: OllamaChatMessage;
  done: true;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

// ── llama.cpp server shapes (internal, what the proxy speaks upstream) ──

export interface LlamaCppCompletionRequest {
  prompt: string;
  n_predict?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop?: readonly string[];
  stream?: false;
  cache_prompt?: boolean;
}

export interface LlamaCppTimings {
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_token_ms?: number;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_token_ms?: number;
  predicted_per_second?: number;
}

export interface LlamaCppCompletionResponse {
  content: string;
  stop: true;
  stopped_eos?: boolean;
  stopped_word?: boolean;
  stopped_limit?: boolean;
  model?: string;
  tokens_predicted?: number;
  tokens_evaluated?: number;
  timings?: LlamaCppTimings;
}

export interface LlamaCppOpenAIRequest {
  model: string;
  messages: readonly OllamaChatMessage[];
  stream?: false;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: readonly string[];
}

export interface LlamaCppOpenAIResponse {
  id?: string;
  object?: string;
  created?: number;
  model: string;
  choices: ReadonlyArray<{
    index?: number;
    message: OllamaChatMessage;
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  timings?: LlamaCppTimings;
}

// ── Translation error type ──────────────────────────────────────────────

export interface LlmRuntimeErrorPayload {
  error: string;
  runtime: RuntimeKind;
  upstream_status?: number;
  upstream_detail?: string;
}
