// dashboard/lib/llm/__tests__/llamacpp-envelope.test.ts
//
// STAQPRO-338 / DR-25 — envelope translation tests for the llama.cpp client.
// HTTP is exercised via injected fetchFn so the suite stays hermetic.

import { describe, expect, it } from 'vitest';
import {
  callLlamaCppChat,
  callLlamaCppGenerate,
  chatRequestToLlamaCpp,
  completionResponseToOllama,
  generateRequestToLlamaCpp,
  openAIResponseToOllamaChat,
} from '../llamacpp-client';
import { readRuntimeKind } from '../runtime';
import type {
  LlamaCppCompletionResponse,
  LlamaCppOpenAIResponse,
  OllamaChatRequest,
  OllamaGenerateRequest,
} from '../types';

describe('generateRequestToLlamaCpp', () => {
  it('maps prompt + supported options', () => {
    const req: OllamaGenerateRequest = {
      model: 'qwen3-4b-ctx4k',
      prompt: 'Classify this email.',
      stream: false,
      options: { temperature: 0.0, num_predict: 64, top_p: 0.9, top_k: 40 },
      stop: ['</classify>'],
    };
    const out = generateRequestToLlamaCpp(req);
    expect(out).toEqual({
      prompt: 'Classify this email.',
      stream: false,
      cache_prompt: true,
      temperature: 0.0,
      n_predict: 64,
      top_p: 0.9,
      top_k: 40,
      stop: ['</classify>'],
    });
  });

  it('omits unset options instead of sending undefined fields', () => {
    const req: OllamaGenerateRequest = { model: 'm', prompt: 'p' };
    const out = generateRequestToLlamaCpp(req);
    expect(out).toEqual({ prompt: 'p', stream: false, cache_prompt: true });
    expect('temperature' in out).toBe(false);
    expect('n_predict' in out).toBe(false);
  });

  it('prefers req.stop over options.stop', () => {
    const out = generateRequestToLlamaCpp({
      model: 'm',
      prompt: 'p',
      stop: ['A'],
      options: { stop: ['B'] },
    });
    expect(out.stop).toEqual(['A']);
  });
});

describe('chatRequestToLlamaCpp', () => {
  it('maps messages and num_predict → max_tokens', () => {
    const req: OllamaChatRequest = {
      model: 'qwen3-4b-ctx4k',
      messages: [
        { role: 'system', content: 'You are a draft assistant.' },
        { role: 'user', content: 'Reply to this customer.' },
      ],
      options: { temperature: 0.7, num_predict: 512, top_p: 0.95, stop: ['</end>'] },
    };
    const out = chatRequestToLlamaCpp(req, 'qwen3-4b-ctx4k');
    expect(out).toEqual({
      model: 'qwen3-4b-ctx4k',
      messages: req.messages,
      stream: false,
      temperature: 0.7,
      max_tokens: 512,
      top_p: 0.95,
      stop: ['</end>'],
    });
  });

  it('uses the configured model name, not the request model field', () => {
    const out = chatRequestToLlamaCpp(
      { model: 'qwen3:4b-ctx4k', messages: [{ role: 'user', content: 'hi' }] },
      'qwen3-4b-ctx4k',
    );
    expect(out.model).toBe('qwen3-4b-ctx4k');
  });
});

describe('completionResponseToOllama', () => {
  it('back-translates a fully-populated llama.cpp /completion envelope', () => {
    const upstream: LlamaCppCompletionResponse = {
      content: 'inquiry|0.92',
      stop: true,
      stopped_eos: true,
      model: 'qwen3-4b-ctx4k',
      tokens_predicted: 8,
      tokens_evaluated: 142,
      timings: {
        prompt_n: 142,
        prompt_ms: 220,
        predicted_n: 8,
        predicted_ms: 430,
      },
    };
    const out = completionResponseToOllama(upstream, 'qwen3-4b-ctx4k');
    expect(out.model).toBe('qwen3-4b-ctx4k');
    expect(out.response).toBe('inquiry|0.92');
    expect(out.done).toBe(true);
    expect(out.prompt_eval_count).toBe(142);
    expect(out.eval_count).toBe(8);
    // ms → ns
    expect(out.prompt_eval_duration).toBe(220_000_000);
    expect(out.eval_duration).toBe(430_000_000);
    expect(out.total_duration).toBe(650_000_000);
    expect(out.done_reason).toBe('stop');
    // created_at is fresh ISO-8601
    expect(() => new Date(out.created_at).toISOString()).not.toThrow();
  });

  it('falls back to tokens_predicted / tokens_evaluated when timings are absent', () => {
    const upstream: LlamaCppCompletionResponse = {
      content: 'x',
      stop: true,
      tokens_predicted: 5,
      tokens_evaluated: 10,
    };
    const out = completionResponseToOllama(upstream, 'm');
    expect(out.prompt_eval_count).toBe(10);
    expect(out.eval_count).toBe(5);
    expect(out.prompt_eval_duration).toBeUndefined();
    expect(out.eval_duration).toBeUndefined();
    expect(out.total_duration).toBeUndefined();
  });

  it('emits done_reason=length when stopped_limit was the terminator', () => {
    const out = completionResponseToOllama({ content: '', stop: true, stopped_limit: true }, 'm');
    expect(out.done_reason).toBe('length');
  });

  it('uses the configured model name when upstream omits model', () => {
    const out = completionResponseToOllama({ content: '', stop: true }, 'qwen3-4b-ctx4k');
    expect(out.model).toBe('qwen3-4b-ctx4k');
  });
});

describe('openAIResponseToOllamaChat', () => {
  it('back-translates a fully-populated /v1/chat/completions envelope', () => {
    const upstream: LlamaCppOpenAIResponse = {
      id: 'cmpl-xyz',
      object: 'chat.completion',
      created: 1715608800,
      model: 'qwen3-4b-ctx4k',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hi! Your order ships tomorrow.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 412, completion_tokens: 27, total_tokens: 439 },
      timings: { prompt_ms: 600, predicted_ms: 1400, prompt_n: 412, predicted_n: 27 },
    };
    const out = openAIResponseToOllamaChat(upstream, 'qwen3-4b-ctx4k');
    expect(out.message).toEqual({ role: 'assistant', content: 'Hi! Your order ships tomorrow.' });
    expect(out.done).toBe(true);
    expect(out.prompt_eval_count).toBe(412);
    expect(out.eval_count).toBe(27);
    expect(out.prompt_eval_duration).toBe(600_000_000);
    expect(out.eval_duration).toBe(1_400_000_000);
    expect(out.total_duration).toBe(2_000_000_000);
    expect(out.done_reason).toBe('stop');
  });

  it('throws when choices is empty (n8n would receive a hard error, not a silent empty)', () => {
    expect(() => openAIResponseToOllamaChat({ model: 'm', choices: [] }, 'm')).toThrow(
      /missing choices/,
    );
  });

  it('falls back to timings.{prompt_n,predicted_n} when usage is absent', () => {
    const out = openAIResponseToOllamaChat(
      {
        model: 'm',
        choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
        timings: { prompt_n: 100, predicted_n: 20 },
      },
      'm',
    );
    expect(out.prompt_eval_count).toBe(100);
    expect(out.eval_count).toBe(20);
  });

  it('emits done_reason=length on finish_reason=length', () => {
    const out = openAIResponseToOllamaChat(
      {
        model: 'm',
        choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
      },
      'm',
    );
    expect(out.done_reason).toBe('length');
  });
});

describe('callLlamaCppGenerate (fetch wiring)', () => {
  it('POSTs to <base>/completion and returns an Ollama-shape envelope', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fetchFn: typeof fetch = async (url, init) => {
      captured.url = url as string;
      captured.init = init;
      const upstream: LlamaCppCompletionResponse = {
        content: 'inquiry|0.92',
        stop: true,
        stopped_eos: true,
        tokens_evaluated: 100,
        tokens_predicted: 5,
        timings: { prompt_ms: 200, predicted_ms: 100 },
      };
      return new Response(JSON.stringify(upstream), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const out = await callLlamaCppGenerate(
      { model: 'qwen3-4b-ctx4k', prompt: 'classify' },
      { fetchFn, baseUrl: 'http://llama-cpp:8080', model: 'qwen3-4b-ctx4k' },
    );
    expect(captured.url).toBe('http://llama-cpp:8080/completion');
    expect(out.response).toBe('inquiry|0.92');
    expect(out.prompt_eval_count).toBe(100);
    expect(out.eval_count).toBe(5);
  });

  it('strips a trailing slash on baseUrl to avoid double-slash URLs', async () => {
    const captured: { url?: string } = {};
    const fetchFn: typeof fetch = async (url) => {
      captured.url = url as string;
      return new Response(JSON.stringify({ content: '', stop: true }), { status: 200 });
    };
    await callLlamaCppGenerate(
      { model: 'm', prompt: 'p' },
      { fetchFn, baseUrl: 'http://llama-cpp:8080/', model: 'm' },
    );
    expect(captured.url).toBe('http://llama-cpp:8080/completion');
  });

  it('throws on non-2xx with status + body preview', async () => {
    const fetchFn: typeof fetch = async () => new Response('model not loaded', { status: 503 });
    await expect(
      callLlamaCppGenerate(
        { model: 'm', prompt: 'p' },
        { fetchFn, baseUrl: 'http://llama-cpp:8080', model: 'm' },
      ),
    ).rejects.toThrow(/503.*model not loaded/);
  });
});

describe('callLlamaCppChat (fetch wiring)', () => {
  it('POSTs to <base>/v1/chat/completions with model + messages', async () => {
    const captured: { url?: string; body?: string } = {};
    const fetchFn: typeof fetch = async (url, init) => {
      captured.url = url as string;
      captured.body = init?.body as string;
      const upstream: LlamaCppOpenAIResponse = {
        model: 'qwen3-4b-ctx4k',
        choices: [
          {
            message: { role: 'assistant', content: 'drafted reply' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 400, completion_tokens: 30 },
      };
      return new Response(JSON.stringify(upstream), { status: 200 });
    };
    const out = await callLlamaCppChat(
      {
        model: 'qwen3-4b-ctx4k',
        messages: [{ role: 'user', content: 'hi' }],
        options: { temperature: 0.5, num_predict: 256 },
      },
      { fetchFn, baseUrl: 'http://llama-cpp:8080', model: 'qwen3-4b-ctx4k' },
    );
    expect(captured.url).toBe('http://llama-cpp:8080/v1/chat/completions');
    const sentBody = JSON.parse(captured.body ?? '{}');
    expect(sentBody.model).toBe('qwen3-4b-ctx4k');
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(sentBody.temperature).toBe(0.5);
    expect(sentBody.max_tokens).toBe(256);
    expect(out.message.content).toBe('drafted reply');
    expect(out.prompt_eval_count).toBe(400);
    expect(out.eval_count).toBe(30);
  });
});

describe('readRuntimeKind (env selector)', () => {
  it('defaults to ollama when LOCAL_INFERENCE_RUNTIME is unset', () => {
    expect(readRuntimeKind({})).toBe('ollama');
  });

  it('returns llama-cpp when explicitly set', () => {
    expect(readRuntimeKind({ LOCAL_INFERENCE_RUNTIME: 'llama-cpp' })).toBe('llama-cpp');
  });

  it('returns ollama when explicitly set', () => {
    expect(readRuntimeKind({ LOCAL_INFERENCE_RUNTIME: 'ollama' })).toBe('ollama');
  });

  it('falls back to ollama with a warning on an unknown value', () => {
    expect(readRuntimeKind({ LOCAL_INFERENCE_RUNTIME: 'mlx' })).toBe('ollama');
  });

  it('trims whitespace', () => {
    expect(readRuntimeKind({ LOCAL_INFERENCE_RUNTIME: '  llama-cpp  ' })).toBe('llama-cpp');
  });
});
