// Ollama client (STAQPRO-338 / DR-25).
//
// Passthrough to Ollama's /api/generate and /api/chat endpoints. No envelope
// translation — the proxy routes use this when LOCAL_INFERENCE_RUNTIME=ollama
// so the response shape is byte-identical to what hitting Ollama directly
// would have produced (the proxy adds ~5-10ms but preserves wire compat).

import type {
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaGenerateRequest,
  OllamaGenerateResponse,
} from './types';

export interface OllamaCallDeps {
  fetchFn?: typeof fetch;
  baseUrl: string;
}

export async function callOllamaGenerate(
  req: OllamaGenerateRequest,
  deps: OllamaCallDeps,
): Promise<OllamaGenerateResponse> {
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(`${deps.baseUrl.replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...req, stream: false }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ollama /api/generate ${res.status}: ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as OllamaGenerateResponse;
}

export async function callOllamaChat(
  req: OllamaChatRequest,
  deps: OllamaCallDeps,
): Promise<OllamaChatResponse> {
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(`${deps.baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...req, stream: false }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ollama /api/chat ${res.status}: ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as OllamaChatResponse;
}
