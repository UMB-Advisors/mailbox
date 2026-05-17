// llama.cpp client + envelope translation (STAQPRO-338 / DR-25).
//
// Translates Ollama-shape requests to llama.cpp `server` endpoints and
// back-translates the responses into Ollama-shape envelopes. The proxy
// routes in dashboard/app/api/internal/llm/api/{generate,chat}/route.ts
// call into these functions; downstream consumers (n8n's classify Normalize
// node, draft-finalize's token-count extraction) see Ollama envelopes
// regardless of which runtime served the call.
//
// Translation rules:
//   /api/generate (string-in, string-out)  → /v1/chat/completions  (attempt-4)
//     prompt              → messages: [{role:"user", content: prompt}]
//     system              → messages: [{role:"system", ...}, ...]  (prepended)
//     options.temperature → temperature
//     options.num_predict → max_tokens
//     options.top_p       → top_p
//     stop                → stop
//     format: "json"      → response_format: {type:"json_object"}
//     think: false        → chat_template_kwargs: {enable_thinking:false}
//   /api/chat (messages-in, message-out)   → /v1/chat/completions
//     messages            → messages
//     options.temperature → temperature
//     options.num_predict → max_tokens
//     options.top_p       → top_p
//     options.stop        → stop
//
// Why /v1/chat/completions for both: llama.cpp's /completion endpoint does
// NOT apply the model's chat template. Sending a Qwen3-shaped classify prompt
// to /completion produces uninstructed-prose output. /v1/chat/completions
// applies the chat template (from GGUF tokenizer.chat_template) and honors
// JSON-mode + per-call template kwargs. Root cause of the 2026-05-14
// attempt-3 cutover roll-back; see docs/dr25-revert-root-cause-2026-05-14.md.
//
// Timing units: llama.cpp reports milliseconds in timings.{prompt,predicted}_ms.
// Ollama reports nanoseconds in {prompt_eval,eval}_duration. Multiply by 1e6.

import type {
  LlamaCppCompletionRequest,
  LlamaCppCompletionResponse,
  LlamaCppOpenAIRequest,
  LlamaCppOpenAIResponse,
  OllamaChatMessage,
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaGenerateRequest,
  OllamaGenerateResponse,
} from './types';

const MS_TO_NS = 1_000_000;

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === 'string');
  return items.length > 0 ? items : undefined;
}

// ── Request translation ────────────────────────────────────────────────

/**
 * Legacy /completion translator. Retained for unit-test coverage of the
 * raw-text envelope; production code now uses `generateRequestToLlamaCppChat`
 * because /completion doesn't apply the model's chat template. STAQPRO-360.
 * @deprecated Use generateRequestToLlamaCppChat for new code.
 */
export function generateRequestToLlamaCpp(req: OllamaGenerateRequest): LlamaCppCompletionRequest {
  const opts = req.options ?? {};
  const out: LlamaCppCompletionRequest = {
    prompt: req.prompt,
    stream: false,
    cache_prompt: true,
  };
  const temperature = readNumber(opts.temperature);
  if (temperature !== undefined) out.temperature = temperature;
  const nPredict = readNumber(opts.num_predict);
  if (nPredict !== undefined) out.n_predict = nPredict;
  const topP = readNumber(opts.top_p);
  if (topP !== undefined) out.top_p = topP;
  const topK = readNumber(opts.top_k);
  if (topK !== undefined) out.top_k = topK;
  const stop = req.stop ?? readStringArray(opts.stop);
  if (stop !== undefined) out.stop = stop;
  return out;
}

/**
 * Translate an Ollama /api/generate request to llama.cpp /v1/chat/completions
 * shape. Wraps the raw prompt as a single user message (prepended by a system
 * message when `req.system` is set). Honors `format:"json"` via OpenAI
 * `response_format` and `think:false` via Qwen3 chat-template kwargs.
 *
 * This is the production path for the classify route; the chat endpoint is
 * the only llama.cpp endpoint that applies the model's chat template.
 */
export function generateRequestToLlamaCppChat(
  req: OllamaGenerateRequest,
  model: string,
): LlamaCppOpenAIRequest {
  const opts = req.options ?? {};
  const messages: OllamaChatMessage[] = [];
  if (req.system && req.system.length > 0) {
    messages.push({ role: 'system', content: req.system });
  }
  messages.push({ role: 'user', content: req.prompt });

  const out: LlamaCppOpenAIRequest = {
    model,
    messages,
    stream: false,
  };
  const temperature = readNumber(opts.temperature);
  if (temperature !== undefined) out.temperature = temperature;
  const maxTokens = readNumber(opts.num_predict);
  if (maxTokens !== undefined) out.max_tokens = maxTokens;
  const topP = readNumber(opts.top_p);
  if (topP !== undefined) out.top_p = topP;
  const stop = req.stop ?? readStringArray(opts.stop);
  if (stop !== undefined) out.stop = stop;
  // NOTE: we intentionally do NOT pass response_format: {type:"json_object"}
  // even when req.format === "json". llama.cpp's json_object grammar accepts
  // any valid JSON object including `{}`, and Qwen3 takes the shortcut —
  // emitting `{}` and stopping (verified 2026-05-14 attempt-4 probe). The
  // upstream classify prompt already contains explicit JSON schema instructions
  // and Qwen3 follows them reliably without the grammar constraint. Future:
  // if we ever need true JSON-shape enforcement we should switch to
  // response_format: {type:"json_schema", json_schema:{...}} with required
  // fields, not the loose json_object form.
  if (req.think === false) {
    out.chat_template_kwargs = { enable_thinking: false };
  }
  return out;
}

export function chatRequestToLlamaCpp(
  req: OllamaChatRequest,
  model: string,
): LlamaCppOpenAIRequest {
  const opts = req.options ?? {};
  const out: LlamaCppOpenAIRequest = {
    model,
    messages: req.messages,
    stream: false,
  };
  const temperature = readNumber(opts.temperature);
  if (temperature !== undefined) out.temperature = temperature;
  const maxTokens = readNumber(opts.num_predict);
  if (maxTokens !== undefined) out.max_tokens = maxTokens;
  const topP = readNumber(opts.top_p);
  if (topP !== undefined) out.top_p = topP;
  const stop = readStringArray(opts.stop);
  if (stop !== undefined) out.stop = stop;
  return out;
}

// ── Response translation ───────────────────────────────────────────────

export function completionResponseToOllama(
  res: LlamaCppCompletionResponse,
  modelName: string,
): OllamaGenerateResponse {
  const t = res.timings ?? {};
  const promptMs = readNumber(t.prompt_ms);
  const predictedMs = readNumber(t.predicted_ms);
  const out: OllamaGenerateResponse = {
    // STAQPRO-361: llama-cpp returns hardcoded `model: "gpt-3.5-turbo"` in its
    // response envelope. Override with the configured LLAMA_CPP_MODEL so
    // downstream telemetry (drafts.model, classification_log.model_version)
    // reflects what actually served the request.
    model: modelName,
    created_at: new Date().toISOString(),
    response: res.content,
    done: true,
  };
  const promptEvalCount = readNumber(t.prompt_n) ?? readNumber(res.tokens_evaluated);
  if (promptEvalCount !== undefined) out.prompt_eval_count = promptEvalCount;
  const evalCount = readNumber(t.predicted_n) ?? readNumber(res.tokens_predicted);
  if (evalCount !== undefined) out.eval_count = evalCount;
  if (promptMs !== undefined) out.prompt_eval_duration = Math.round(promptMs * MS_TO_NS);
  if (predictedMs !== undefined) out.eval_duration = Math.round(predictedMs * MS_TO_NS);
  if (promptMs !== undefined && predictedMs !== undefined) {
    out.total_duration = Math.round((promptMs + predictedMs) * MS_TO_NS);
  }
  if (res.stopped_eos) out.done_reason = 'stop';
  else if (res.stopped_limit) out.done_reason = 'length';
  else if (res.stopped_word) out.done_reason = 'stop';
  return out;
}

/**
 * Translate llama.cpp /v1/chat/completions response into Ollama
 * /api/generate envelope shape. Used by the production /api/generate proxy
 * path (the chat endpoint is the only one that applies chat templates).
 */
export function chatResponseToOllamaGenerate(
  res: LlamaCppOpenAIResponse,
  modelName: string,
): OllamaGenerateResponse {
  const choice = res.choices[0];
  if (!choice) {
    throw new Error('llama-cpp response missing choices[0]');
  }
  const usage = res.usage ?? {};
  const timings = res.timings ?? {};
  const promptMs = readNumber(timings.prompt_ms);
  const predictedMs = readNumber(timings.predicted_ms);
  const out: OllamaGenerateResponse = {
    // STAQPRO-361: llama-cpp returns hardcoded `model: "gpt-3.5-turbo"` in its
    // response envelope. Override with the configured LLAMA_CPP_MODEL so
    // downstream telemetry reflects what actually served the request.
    model: modelName,
    created_at: new Date().toISOString(),
    response: choice.message.content,
    done: true,
  };
  const promptEvalCount = readNumber(usage.prompt_tokens) ?? readNumber(timings.prompt_n);
  if (promptEvalCount !== undefined) out.prompt_eval_count = promptEvalCount;
  const evalCount = readNumber(usage.completion_tokens) ?? readNumber(timings.predicted_n);
  if (evalCount !== undefined) out.eval_count = evalCount;
  if (promptMs !== undefined) out.prompt_eval_duration = Math.round(promptMs * MS_TO_NS);
  if (predictedMs !== undefined) out.eval_duration = Math.round(predictedMs * MS_TO_NS);
  if (promptMs !== undefined && predictedMs !== undefined) {
    out.total_duration = Math.round((promptMs + predictedMs) * MS_TO_NS);
  }
  if (choice.finish_reason === 'stop') out.done_reason = 'stop';
  else if (choice.finish_reason === 'length') out.done_reason = 'length';
  return out;
}

export function openAIResponseToOllamaChat(
  res: LlamaCppOpenAIResponse,
  modelName: string,
): OllamaChatResponse {
  const choice = res.choices[0];
  if (!choice) {
    throw new Error('llama-cpp response missing choices[0]');
  }
  const usage = res.usage ?? {};
  const timings = res.timings ?? {};
  const promptMs = readNumber(timings.prompt_ms);
  const predictedMs = readNumber(timings.predicted_ms);
  const out: OllamaChatResponse = {
    // STAQPRO-361: llama-cpp returns hardcoded `model: "gpt-3.5-turbo"` in its
    // response envelope. Override with the configured LLAMA_CPP_MODEL so
    // downstream telemetry (drafts.model, classification_log.model_version)
    // reflects what actually served the request.
    model: modelName,
    created_at: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: choice.message.content,
    },
    done: true,
  };
  const promptEvalCount = readNumber(usage.prompt_tokens) ?? readNumber(timings.prompt_n);
  if (promptEvalCount !== undefined) out.prompt_eval_count = promptEvalCount;
  const evalCount = readNumber(usage.completion_tokens) ?? readNumber(timings.predicted_n);
  if (evalCount !== undefined) out.eval_count = evalCount;
  if (promptMs !== undefined) out.prompt_eval_duration = Math.round(promptMs * MS_TO_NS);
  if (predictedMs !== undefined) out.eval_duration = Math.round(predictedMs * MS_TO_NS);
  if (promptMs !== undefined && predictedMs !== undefined) {
    out.total_duration = Math.round((promptMs + predictedMs) * MS_TO_NS);
  }
  if (choice.finish_reason === 'stop') out.done_reason = 'stop';
  else if (choice.finish_reason === 'length') out.done_reason = 'length';
  return out;
}

// ── Fetcher (callable; injectable for tests) ────────────────────────────

export interface LlamaCppCallDeps {
  fetchFn?: typeof fetch;
  baseUrl: string;
  model: string;
}

export async function callLlamaCppGenerate(
  req: OllamaGenerateRequest,
  deps: LlamaCppCallDeps,
): Promise<OllamaGenerateResponse> {
  const fetchFn = deps.fetchFn ?? fetch;
  // STAQPRO-360 attempt-4: route Ollama /api/generate → llama.cpp
  // /v1/chat/completions so the model's chat template is applied. The legacy
  // /completion endpoint produces uninstructed prose for Qwen3 prompts.
  const upstreamReq = generateRequestToLlamaCppChat(req, deps.model);
  const res = await fetchFn(`${deps.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(upstreamReq),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`llama-cpp /v1/chat/completions ${res.status}: ${detail.slice(0, 300)}`);
  }
  const upstreamRes = (await res.json()) as LlamaCppOpenAIResponse;
  return chatResponseToOllamaGenerate(upstreamRes, deps.model);
}

export async function callLlamaCppChat(
  req: OllamaChatRequest,
  deps: LlamaCppCallDeps,
): Promise<OllamaChatResponse> {
  const fetchFn = deps.fetchFn ?? fetch;
  const upstreamReq = chatRequestToLlamaCpp(req, deps.model);
  const res = await fetchFn(`${deps.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(upstreamReq),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`llama-cpp /v1/chat/completions ${res.status}: ${detail.slice(0, 300)}`);
  }
  const upstreamRes = (await res.json()) as LlamaCppOpenAIResponse;
  return openAIResponseToOllamaChat(upstreamRes, deps.model);
}
