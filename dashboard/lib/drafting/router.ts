// Drafting endpoint router (2026-04-30 cloud-path pivot; 2026-05-13 DR-25 amend).
//
// Given a classification category + confidence, return the Ollama-compatible
// endpoint, model, and credentials that the n8n 04-draft-sub workflow should
// use. Local and cloud share the same /api/chat schema, so the only thing
// that changes is baseUrl + model + apiKey.
//
// DR-25: when LOCAL_INFERENCE_RUNTIME=llama-cpp, the local route points at
// the dashboard's own /api/internal/llm proxy. The proxy translates between
// Ollama and llama.cpp wire shapes upstream; n8n still sees an Ollama
// envelope. LOCAL_INFERENCE_RUNTIME=ollama (default) keeps the historical
// direct-Ollama path with zero proxy overhead.
//
// The routing rule itself lives in lib/classification/prompt.ts:routeFor —
// kept there because the n8n classify sub-workflow's IF node already mirrors
// it (D-30) and we want a single source of truth.

import type { Category } from '@/lib/classification/prompt';
import { routeFor } from '@/lib/classification/prompt';
import { readLlamaCppModel, readOllamaBaseUrl, readRuntimeKind } from '@/lib/llm/runtime';
import { DRAFT_CLOUD_MODEL_DEFAULT, DRAFT_LOCAL_MODEL } from './prompt';

export type DraftSource = 'local' | 'cloud';

export interface DraftEndpoint {
  source: DraftSource;
  // Base URL to POST `/api/chat` against (Ollama-compatible).
  baseUrl: string;
  model: string;
  // API key to attach as `Authorization: Bearer <key>`. Empty string for
  // local Ollama (no auth on the internal Docker network).
  apiKey: string;
  // Surfaced for the dashboard UI / logs only — n8n doesn't need it.
  display_label: string;
}

const OLLAMA_CLOUD_BASE = process.env.OLLAMA_CLOUD_BASE_URL ?? 'https://ollama.com';
const OLLAMA_CLOUD_MODEL = process.env.OLLAMA_CLOUD_MODEL ?? DRAFT_CLOUD_MODEL_DEFAULT;
const OLLAMA_CLOUD_KEY = process.env.OLLAMA_CLOUD_API_KEY ?? '';

// In-cluster dashboard URL. n8n composes `${baseUrl}/api/chat` against this
// when the local runtime is llama-cpp; the path resolves to the proxy at
// dashboard/app/api/internal/llm/api/chat/route.ts.
const DASHBOARD_LLM_PROXY_BASE =
  process.env.DASHBOARD_LLM_PROXY_BASE_URL ?? 'http://mailbox-dashboard:3001/api/internal/llm';

function pickLocalEndpoint(): DraftEndpoint {
  const runtime = readRuntimeKind();
  if (runtime === 'llama-cpp') {
    const model = readLlamaCppModel();
    return {
      source: 'local',
      baseUrl: DASHBOARD_LLM_PROXY_BASE,
      model,
      apiKey: '',
      display_label: `Local llama.cpp (${model})`,
    };
  }
  return {
    source: 'local',
    baseUrl: readOllamaBaseUrl(),
    model: DRAFT_LOCAL_MODEL,
    apiKey: '',
    display_label: `Local Ollama (${DRAFT_LOCAL_MODEL})`,
  };
}

export function pickEndpoint(category: Category, confidence: number): DraftEndpoint {
  const route = routeFor(category, confidence);
  // 'drop' shouldn't reach drafting, but be defensive: fall through to local.
  if (route === 'cloud') {
    return {
      source: 'cloud',
      baseUrl: OLLAMA_CLOUD_BASE,
      model: OLLAMA_CLOUD_MODEL,
      apiKey: OLLAMA_CLOUD_KEY,
      display_label: `Ollama Cloud (${OLLAMA_CLOUD_MODEL})`,
    };
  }
  return pickLocalEndpoint();
}
