import { type NextRequest, NextResponse } from 'next/server';
import { callLlamaCppChat } from '@/lib/llm/llamacpp-client';
import { callOllamaChat } from '@/lib/llm/ollama-client';
import {
  readLlamaCppBaseUrl,
  readLlamaCppModel,
  readOllamaBaseUrl,
  readRuntimeKind,
} from '@/lib/llm/runtime';
import type { OllamaChatRequest, OllamaChatResponse } from '@/lib/llm/types';
import { parseJson } from '@/lib/middleware/validate';
import { llmChatBodySchema } from '@/lib/schemas/internal';

// POST /api/internal/llm/api/chat — Ollama-shape proxy for the draft path.
// Mirrors `/api/chat` to keep the n8n workflow's `={{ baseUrl }}/api/chat`
// template valid when baseUrl points at the dashboard. STAQPRO-338 / DR-25.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const parsed = await parseJson(req, llmChatBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data as OllamaChatRequest;

  const runtime = readRuntimeKind();
  try {
    let result: OllamaChatResponse;
    if (runtime === 'llama-cpp') {
      result = await callLlamaCppChat(body, {
        baseUrl: readLlamaCppBaseUrl(),
        model: readLlamaCppModel(),
      });
    } else {
      result = await callOllamaChat(body, { baseUrl: readOllamaBaseUrl() });
    }
    return NextResponse.json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: 'upstream_failed', runtime, upstream_detail: detail },
      { status: 502 },
    );
  }
}
