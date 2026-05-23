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
  /** Ollama-side thinking-mode toggle (Qwen3 native param). Forwarded to
   *  llama.cpp via chat_template_kwargs.enable_thinking. STAQPRO-360. */
  think?: boolean;
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
  /** OpenAI-compatible JSON-mode hint. Set when caller passes Ollama
   *  `format: "json"`. llama.cpp's /v1/chat/completions honors this and
   *  grammar-constrains the output to a valid JSON object. STAQPRO-360. */
  response_format?: { type: 'json_object' | 'text' };
  /** Per-call template overrides forwarded to the model's chat template
   *  (e.g., Qwen3's `enable_thinking` flag). llama.cpp passes these into
   *  the Jinja template evaluator. STAQPRO-360. */
  chat_template_kwargs?: Record<string, unknown>;
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

// ── Interactive streaming (MBOX-284 / DR-25 streaming consumer) ──────────
//
// The non-streaming envelopes above stay the contract for the draft pipeline
// (n8n calls /api/chat with stream:false). The shapes below model the
// token-by-token path used by the chat UI (MBOX-287). They are LOCAL-ONLY by
// construction (DR-53 / SM-73): the streaming relay only ever talks to the
// runtime selected by LOCAL_INFERENCE_RUNTIME — there is no cloud baseUrl seam.
//
// `StreamEvent` is the normalized internal event the relay yields regardless
// of which upstream wire shape served it (llama.cpp OpenAI SSE deltas or
// Ollama NDJSON chunks). The SSE serializer turns these into
// `event: <type>\ndata: <json>\n\n` frames for the browser.

/** A normalized streaming event the dashboard relay yields to the browser. */
export type StreamEvent = StreamTokenEvent | StreamDoneEvent | StreamErrorEvent;

/** One incremental chunk of assistant text. `delta` is append-only. */
export interface StreamTokenEvent {
  type: 'token';
  delta: string;
}

/** Terminal success event carrying final metadata for persistence (MBOX-285). */
export interface StreamDoneEvent {
  type: 'done';
  /** The model that actually served the turn (configured local model name). */
  model: string;
  /** Reason the runtime stopped, normalized to Ollama's vocabulary. */
  done_reason?: 'stop' | 'length';
  /** Prompt (input) token count when the runtime reports it. */
  prompt_eval_count?: number;
  /** Generated (output) token count when the runtime reports it. */
  eval_count?: number;
}

/**
 * Terminal failure event. `code` distinguishes a genuine local-runtime outage
 * ('local_unavailable' — the SM-70/AC "box unavailable" case) from a malformed
 * upstream stream ('upstream_malformed'). The chat UI must render
 * 'local_unavailable' distinctly from a normal empty response (AC requirement).
 */
export interface StreamErrorEvent {
  type: 'error';
  code: 'local_unavailable' | 'upstream_malformed';
  detail: string;
  runtime: RuntimeKind;
}

/** A streaming /api/chat request. Mirrors OllamaChatRequest but stream:true. */
export interface OllamaChatStreamRequest {
  model: string;
  messages: readonly OllamaChatMessage[];
  stream: true;
  options?: Record<string, unknown>;
}

// ── Upstream streaming chunk shapes (internal, what the relay parses) ────

/** One NDJSON line from Ollama's /api/chat stream:true response. */
export interface OllamaChatStreamChunk {
  model: string;
  created_at?: string;
  message?: { role: 'assistant'; content: string };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** One `data:` frame payload from llama.cpp's /v1/chat/completions SSE. */
export interface LlamaCppOpenAIStreamChunk {
  id?: string;
  object?: string;
  model?: string;
  choices: ReadonlyArray<{
    index?: number;
    delta?: { role?: 'assistant'; content?: string };
    finish_reason?: string | null;
  }>;
  /** llama.cpp attaches usage/timings on the final chunk when stream_options
   *  request it; both are tolerated-absent. */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  timings?: LlamaCppTimings;
}
