// Interactive streaming relay for the local model (MBOX-284 / DR-25).
//
// The non-streaming clients (ollama-client.ts, llamacpp-client.ts) stay the
// contract for the draft pipeline. This module adds the token-by-token path
// the chat UI (MBOX-287) consumes. It is LOCAL-ONLY by construction
// (DR-53 / SM-73): callers pass the local runtime's baseUrl + model only.
// There is deliberately no cloud baseUrl seam here, so no chat-stream code
// path can reach Ollama Cloud / Anthropic.
//
// Wire shapes the relay normalizes into `StreamEvent`:
//   llama-cpp → POST {base}/v1/chat/completions  body { stream:true, ... }
//               OpenAI SSE: lines of `data: {chunk}` + terminal `data: [DONE]`
//               token text lives at choices[0].delta.content
//   ollama    → POST {base}/api/chat              body { stream:true, ... }
//               NDJSON: one JSON object per line; token text at message.content;
//               terminal object has done:true (+ prompt_eval_count / eval_count)
//
// Both are parsed line-by-line off the upstream ReadableStream and re-emitted
// as a normalized AsyncGenerator<StreamEvent>. The route layer serializes
// those events to browser-facing SSE (see sse.ts).
//
// Testability: `fetchFn` is injectable and the upstream body is a ReadableStream,
// so the whole relay is exercised hermetically with a mocked stream — no
// on-box llama.cpp needed. ON-BOX VALIDATION STILL REQUIRED for the real
// llama.cpp SSE framing + first-token latency (SM-70); see SUMMARY.

import type {
  LlamaCppOpenAIStreamChunk,
  OllamaChatMessage,
  OllamaChatStreamChunk,
  RuntimeKind,
  StreamEvent,
} from './types';

export interface StreamCallDeps {
  fetchFn?: typeof fetch;
  /** Local runtime base URL ONLY. Never a cloud endpoint (DR-53 / SM-73). */
  baseUrl: string;
  /** Configured local model name; overrides whatever the runtime echoes. */
  model: string;
  /** AbortSignal so a disconnected browser tears down the upstream fetch. */
  signal?: AbortSignal;
}

export interface StreamChatInput {
  messages: readonly OllamaChatMessage[];
  options?: Record<string, unknown>;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeDoneReason(raw: string | null | undefined): 'stop' | 'length' | undefined {
  if (raw === 'stop') return 'stop';
  if (raw === 'length') return 'length';
  return undefined;
}

/**
 * Split a byte stream into complete text lines, holding any trailing partial
 * line in `buffer` across reads. Yields decoded lines (without the newline).
 * Flushes the final non-empty buffer on stream end.
 */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
        buffer = buffer.slice(newlineIdx + 1);
        yield line;
        newlineIdx = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    const tail = buffer.replace(/\r$/, '');
    if (tail.length > 0) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse llama.cpp's OpenAI-compatible SSE stream into normalized StreamEvents.
 * Frames look like `data: {json}` with a terminal `data: [DONE]`. Token text
 * is choices[0].delta.content; finish_reason and usage land on later chunks.
 */
async function* parseLlamaCppStream(
  body: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<StreamEvent, void, unknown> {
  let doneReason: 'stop' | 'length' | undefined;
  let promptEvalCount: number | undefined;
  let evalCount: number | undefined;
  let sawTerminal = false;

  for await (const line of readLines(body)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith('data:')) continue; // ignore comments / event: lines
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '[DONE]') {
      sawTerminal = true;
      break;
    }
    let chunk: LlamaCppOpenAIStreamChunk;
    try {
      chunk = JSON.parse(payload) as LlamaCppOpenAIStreamChunk;
    } catch {
      yield {
        type: 'error',
        code: 'upstream_malformed',
        detail: `unparseable SSE frame: ${payload.slice(0, 120)}`,
        runtime: 'llama-cpp',
      };
      return;
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      yield { type: 'token', delta };
    }
    const fr = normalizeDoneReason(choice?.finish_reason);
    if (fr) doneReason = fr;
    const pe = readNumber(chunk.usage?.prompt_tokens) ?? readNumber(chunk.timings?.prompt_n);
    if (pe !== undefined) promptEvalCount = pe;
    const ev = readNumber(chunk.usage?.completion_tokens) ?? readNumber(chunk.timings?.predicted_n);
    if (ev !== undefined) evalCount = ev;
  }

  if (!sawTerminal && doneReason === undefined && promptEvalCount === undefined) {
    // Stream ended without a [DONE] sentinel and without any terminal signal —
    // treat as a truncated/aborted upstream rather than a clean completion.
    yield {
      type: 'error',
      code: 'upstream_malformed',
      detail: 'llama.cpp stream ended without [DONE] or finish_reason',
      runtime: 'llama-cpp',
    };
    return;
  }

  const event = { type: 'done' as const, model };
  yield {
    ...event,
    ...(doneReason !== undefined ? { done_reason: doneReason } : {}),
    ...(promptEvalCount !== undefined ? { prompt_eval_count: promptEvalCount } : {}),
    ...(evalCount !== undefined ? { eval_count: evalCount } : {}),
  };
}

/**
 * Parse Ollama's NDJSON /api/chat stream into normalized StreamEvents. Each
 * line is a JSON object; token text is message.content; the terminal object
 * has done:true plus the eval counts.
 */
async function* parseOllamaStream(
  body: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<StreamEvent, void, unknown> {
  let sawDone = false;
  for await (const line of readLines(body)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let chunk: OllamaChatStreamChunk;
    try {
      chunk = JSON.parse(trimmed) as OllamaChatStreamChunk;
    } catch {
      yield {
        type: 'error',
        code: 'upstream_malformed',
        detail: `unparseable NDJSON line: ${trimmed.slice(0, 120)}`,
        runtime: 'ollama',
      };
      return;
    }
    const delta = chunk.message?.content;
    if (typeof delta === 'string' && delta.length > 0 && !chunk.done) {
      yield { type: 'token', delta };
    }
    if (chunk.done) {
      sawDone = true;
      const doneReason = normalizeDoneReason(chunk.done_reason);
      const promptEvalCount = readNumber(chunk.prompt_eval_count);
      const evalCount = readNumber(chunk.eval_count);
      yield {
        type: 'done',
        model,
        ...(doneReason !== undefined ? { done_reason: doneReason } : {}),
        ...(promptEvalCount !== undefined ? { prompt_eval_count: promptEvalCount } : {}),
        ...(evalCount !== undefined ? { eval_count: evalCount } : {}),
      };
      return;
    }
  }
  if (!sawDone) {
    yield {
      type: 'error',
      code: 'upstream_malformed',
      detail: 'ollama stream ended without a done:true chunk',
      runtime: 'ollama',
    };
  }
}

/**
 * Open a streaming chat against the LOCAL runtime and yield normalized
 * StreamEvents. The very first thing emitted on a connect/HTTP failure is a
 * 'local_unavailable' error event — the AC's "box unavailable" case, kept
 * distinct from a clean empty response (which would be a single 'done' with
 * no preceding tokens).
 */
export async function* streamLocalChat(
  runtime: RuntimeKind,
  input: StreamChatInput,
  deps: StreamCallDeps,
): AsyncGenerator<StreamEvent, void, unknown> {
  const fetchFn = deps.fetchFn ?? fetch;
  const base = deps.baseUrl.replace(/\/$/, '');

  const url = runtime === 'llama-cpp' ? `${base}/v1/chat/completions` : `${base}/api/chat`;
  const requestBody =
    runtime === 'llama-cpp'
      ? {
          model: deps.model,
          messages: input.messages,
          stream: true,
          ...mapLlamaCppOptions(input.options),
        }
      : {
          model: deps.model,
          messages: input.messages,
          stream: true,
          ...(input.options ? { options: input.options } : {}),
        };

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: deps.signal,
    });
  } catch (err) {
    // Connection refused / DNS / abort before any bytes → the box is down.
    yield {
      type: 'error',
      code: 'local_unavailable',
      detail: err instanceof Error ? err.message : String(err),
      runtime,
    };
    return;
  }

  if (!res.ok || !res.body) {
    const detail = res.body ? await res.text().catch(() => '') : 'no response body';
    yield {
      type: 'error',
      code: 'local_unavailable',
      detail: `local runtime ${res.status}: ${detail.slice(0, 200)}`,
      runtime,
    };
    return;
  }

  if (runtime === 'llama-cpp') {
    yield* parseLlamaCppStream(res.body, deps.model);
  } else {
    yield* parseOllamaStream(res.body, deps.model);
  }
}

/**
 * Map the Ollama-style `options` bag to llama.cpp /v1/chat/completions
 * top-level params. Mirrors the non-streaming chatRequestToLlamaCpp mapping
 * (num_predict → max_tokens, etc.) so streaming and non-streaming behave the
 * same on the same inputs.
 */
function mapLlamaCppOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!options) return {};
  const out: Record<string, unknown> = {};
  const temperature = readNumber(options.temperature);
  if (temperature !== undefined) out.temperature = temperature;
  const maxTokens = readNumber(options.num_predict);
  if (maxTokens !== undefined) out.max_tokens = maxTokens;
  const topP = readNumber(options.top_p);
  if (topP !== undefined) out.top_p = topP;
  if (Array.isArray(options.stop)) {
    const stop = options.stop.filter((v): v is string => typeof v === 'string');
    if (stop.length > 0) out.stop = stop;
  }
  return out;
}

// Exported for unit tests (line splitting + per-runtime parsing in isolation).
export const __test = { readLines, parseLlamaCppStream, parseOllamaStream, mapLlamaCppOptions };
