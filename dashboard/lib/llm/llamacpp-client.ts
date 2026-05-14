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
//   /api/generate (string-in, string-out)  → /completion
//     prompt              → prompt
//     options.temperature → temperature
//     options.num_predict → n_predict
//     options.top_p       → top_p
//     options.top_k       → top_k
//     stop                → stop
//   /api/chat (messages-in, message-out)   → /v1/chat/completions
//     messages            → messages
//     options.temperature → temperature
//     options.num_predict → max_tokens
//     options.top_p       → top_p
//     options.stop        → stop
//
// Timing units: llama.cpp reports milliseconds in timings.{prompt,predicted}_ms.
// Ollama reports nanoseconds in {prompt_eval,eval}_duration. Multiply by 1e6.

import type {
  LlamaCppCompletionRequest,
  LlamaCppCompletionResponse,
  LlamaCppOpenAIRequest,
  LlamaCppOpenAIResponse,
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
    model: res.model ?? modelName,
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
    model: res.model ?? modelName,
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
  const upstreamReq = generateRequestToLlamaCpp(req);
  const res = await fetchFn(`${deps.baseUrl.replace(/\/$/, '')}/completion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(upstreamReq),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`llama-cpp /completion ${res.status}: ${detail.slice(0, 300)}`);
  }
  const upstreamRes = (await res.json()) as LlamaCppCompletionResponse;
  return completionResponseToOllama(upstreamRes, deps.model);
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
