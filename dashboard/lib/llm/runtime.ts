// Runtime selector (STAQPRO-338 / DR-25).
//
// LOCAL_INFERENCE_RUNTIME picks the local inference backend:
//   'ollama'   — direct hit to LOCAL_OLLAMA_BASE (current default)
//   'llama-cpp' — route through the dashboard proxy, which translates
//                 Ollama wire shapes to llama.cpp's /completion and
//                 /v1/chat/completions endpoints
//
// Cloud routes are unaffected; the cloud path's baseUrl is dashboard-provided
// per call and the cloud runtimes (Ollama Cloud, Anthropic) already speak
// Ollama-compatible shapes natively.

import type { RuntimeKind } from './types';

const VALID_RUNTIMES = ['ollama', 'llama-cpp'] as const satisfies readonly RuntimeKind[];

export function readRuntimeKind(
  env: Record<string, string | undefined> = process.env,
): RuntimeKind {
  const raw = env.LOCAL_INFERENCE_RUNTIME?.trim();
  if (!raw) return 'ollama';
  if ((VALID_RUNTIMES as readonly string[]).includes(raw)) {
    return raw as RuntimeKind;
  }
  // Fail closed: an unrecognised value is more dangerous than a quiet default,
  // but we don't want a single typo to dark-classify the inbox. Log and fall
  // back to ollama (the historical default).
  // eslint-disable-next-line no-console
  console.warn(
    `[llm/runtime] Unknown LOCAL_INFERENCE_RUNTIME=${raw}; falling back to 'ollama'. Valid: ${VALID_RUNTIMES.join(', ')}`,
  );
  return 'ollama';
}

export function readOllamaBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.OLLAMA_BASE_URL ?? 'http://ollama:11434';
}

export function readLlamaCppBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.LLAMA_CPP_BASE_URL ?? 'http://llama-cpp:8080';
}

export function readLlamaCppModel(env: Record<string, string | undefined> = process.env): string {
  return env.LLAMA_CPP_MODEL ?? 'qwen3-4b-ctx4k';
}
