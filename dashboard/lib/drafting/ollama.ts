// Thin Ollama HTTP client for the drafting path.
//
// Single function works for both the local Ollama daemon (http://ollama:11434)
// and Ollama Cloud (https://ollama.com), because both speak the same
// /api/chat schema. The n8n 04-draft-sub workflow does not call this directly
// — it uses an n8n HTTP Request node — but the same shape is used so the two
// stay in sync (and so dashboard-side diagnostics / future scoring scripts
// can call this directly).

import type { ChatMessage } from './prompt';

export interface OllamaChatRequest {
  model: string;
  messages: ReadonlyArray<ChatMessage>;
  options?: {
    temperature?: number;
    num_predict?: number; // Ollama's name for max_tokens
  };
  stream?: false;
}

// Subset of the Ollama /api/chat response we care about. Ollama Cloud returns
// the same shape (it's the OpenAI-compat surface wrapped in Ollama's response
// format).
export interface OllamaChatResponse {
  model: string;
  message: { role: 'assistant'; content: string };
  done: boolean;
  // Token accounting — present on both local and cloud responses.
  prompt_eval_count?: number;
  eval_count?: number;
  // Latencies (ns) — informational only.
  total_duration?: number;
  load_duration?: number;
  eval_duration?: number;
}

export interface OllamaChatResult {
  body: string;
  input_tokens: number;
  output_tokens: number;
  eval_duration_ms: number | null;
}

export interface OllamaCallParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ReadonlyArray<ChatMessage>;
  temperature?: number;
  max_tokens?: number;
  // Per-request timeout. Local Qwen3:4b drafts land in 5-17s; cloud models
  // typically <10s. 90s is a generous ceiling that still surfaces hangs.
  timeout_ms?: number;
}

const DEFAULT_TIMEOUT_MS = 90_000;

export async function chat(params: OllamaCallParams): Promise<OllamaChatResult> {
  const url = new URL('/api/chat', params.baseUrl).toString();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (params.apiKey) {
    headers.Authorization = `Bearer ${params.apiKey}`;
  }

  const body: OllamaChatRequest = {
    model: params.model,
    messages: params.messages,
    stream: false,
    options: {
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      ...(params.max_tokens !== undefined && { num_predict: params.max_tokens }),
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(params.timeout_ms ?? DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Ollama ${url} returned ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as OllamaChatResponse;
  return {
    body: json.message?.content ?? '',
    input_tokens: json.prompt_eval_count ?? 0,
    output_tokens: json.eval_count ?? 0,
    eval_duration_ms: json.eval_duration
      ? Math.round(json.eval_duration / 1_000_000)
      : null,
  };
}
