// Drafting endpoint router (2026-04-30 cloud-path pivot).
//
// Given a classification category + confidence, return the Ollama-compatible
// endpoint, model, and credentials that the n8n 04-draft-sub workflow should
// use. Local and cloud share the same /api/chat schema, so the only thing
// that changes is baseUrl + model + apiKey.
//
// The routing rule itself lives in lib/classification/prompt.ts:routeFor —
// kept there because the n8n classify sub-workflow's IF node already mirrors
// it (D-30) and we want a single source of truth.

import type { Category } from '@/lib/classification/prompt';
import { routeFor } from '@/lib/classification/prompt';
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

const LOCAL_OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434';
const OLLAMA_CLOUD_BASE = process.env.OLLAMA_CLOUD_BASE_URL ?? 'https://ollama.com';
const OLLAMA_CLOUD_MODEL = process.env.OLLAMA_CLOUD_MODEL ?? DRAFT_CLOUD_MODEL_DEFAULT;
const OLLAMA_CLOUD_KEY = process.env.OLLAMA_CLOUD_API_KEY ?? '';

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
  return {
    source: 'local',
    baseUrl: LOCAL_OLLAMA_BASE,
    model: DRAFT_LOCAL_MODEL,
    apiKey: '',
    display_label: `Local Ollama (${DRAFT_LOCAL_MODEL})`,
  };
}
