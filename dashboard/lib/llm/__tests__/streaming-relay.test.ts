// dashboard/lib/llm/__tests__/streaming-relay.test.ts
//
// MBOX-284 / DR-25 — token-streaming relay tests. The upstream runtime is
// mocked as a ReadableStream via an injected fetchFn, so the suite is hermetic
// (no on-box llama.cpp / Ollama). Covers both wire shapes, the SSE serializer,
// the local-only error semantics, and chunked-line reassembly.

import { describe, expect, it } from 'vitest';
import { SSE_HEADERS, sseStreamFromEvents, toSseFrame } from '../sse';
import { __test, streamLocalChat } from '../streaming-client';
import type { RuntimeKind, StreamEvent } from '../types';

// ── helpers ──────────────────────────────────────────────────────────────

/** Build a ReadableStream that emits the given string parts as UTF-8 bytes. */
function streamOf(parts: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < parts.length) {
        controller.enqueue(encoder.encode(parts[i]));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

/** A fetchFn that returns a 200 with the given body stream. */
function fetchReturning(body: ReadableStream<Uint8Array>, status = 200): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch;
}

async function collect(gen: AsyncGenerator<StreamEvent, void, unknown>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

async function drainSse(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

// ── readLines (chunk reassembly) ───────────────────────────────────────────

describe('readLines', () => {
  it('reassembles lines split across chunk boundaries', async () => {
    const stream = streamOf(['hel', 'lo\nwor', 'ld\n']);
    const lines: string[] = [];
    for await (const l of __test.readLines(stream)) lines.push(l);
    expect(lines).toEqual(['hello', 'world']);
  });

  it('flushes a trailing line with no terminating newline', async () => {
    const stream = streamOf(['a\nb']);
    const lines: string[] = [];
    for await (const l of __test.readLines(stream)) lines.push(l);
    expect(lines).toEqual(['a', 'b']);
  });

  it('strips CR for CRLF-framed streams', async () => {
    const stream = streamOf(['x\r\ny\r\n']);
    const lines: string[] = [];
    for await (const l of __test.readLines(stream)) lines.push(l);
    expect(lines).toEqual(['x', 'y']);
  });
});

// ── llama.cpp SSE parsing ──────────────────────────────────────────────────

describe('streamLocalChat — llama-cpp (OpenAI SSE)', () => {
  function sseChunk(content?: string, finish?: string): string {
    const choice: Record<string, unknown> = { index: 0, delta: {} };
    if (content !== undefined) (choice.delta as Record<string, unknown>).content = content;
    if (finish !== undefined) choice.finish_reason = finish;
    return `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
  }

  it('emits token events then a done event with metadata', async () => {
    const body = streamOf([
      sseChunk('Hi'),
      sseChunk(' there'),
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 2 },
      })}\n\n`,
      'data: [DONE]\n\n',
    ]);
    const events = await collect(
      streamLocalChat(
        'llama-cpp',
        { messages: [{ role: 'user', content: 'hi' }] },
        {
          fetchFn: fetchReturning(body),
          baseUrl: 'http://llama-cpp:8080',
          model: 'qwen3-4b-ctx4k',
        },
      ),
    );
    expect(events).toEqual([
      { type: 'token', delta: 'Hi' },
      { type: 'token', delta: ' there' },
      {
        type: 'done',
        model: 'qwen3-4b-ctx4k',
        done_reason: 'stop',
        prompt_eval_count: 12,
        eval_count: 2,
      },
    ]);
  });

  it('POSTs stream:true to /v1/chat/completions with the configured model', async () => {
    const captured: { url?: string; body?: string } = {};
    const fetchFn: typeof fetch = async (url, init) => {
      captured.url = url as string;
      captured.body = init?.body as string;
      return new Response(streamOf(['data: [DONE]\n\n']), { status: 200 });
    };
    await collect(
      streamLocalChat(
        'llama-cpp',
        {
          messages: [{ role: 'user', content: 'hi' }],
          options: { num_predict: 256, temperature: 0.7 },
        },
        { fetchFn, baseUrl: 'http://llama-cpp:8080/', model: 'qwen3-4b-ctx4k' },
      ),
    );
    expect(captured.url).toBe('http://llama-cpp:8080/v1/chat/completions');
    const sent = JSON.parse(captured.body ?? '{}');
    expect(sent.stream).toBe(true);
    expect(sent.model).toBe('qwen3-4b-ctx4k');
    expect(sent.max_tokens).toBe(256);
    expect(sent.temperature).toBe(0.7);
  });

  it('emits done even when [DONE] is absent but finish_reason arrived', async () => {
    const body = streamOf([sseChunk('x', 'length')]);
    const events = await collect(
      streamLocalChat(
        'llama-cpp',
        { messages: [{ role: 'user', content: 'hi' }] },
        { fetchFn: fetchReturning(body), baseUrl: 'http://llama-cpp:8080', model: 'm' },
      ),
    );
    expect(events).toEqual([
      { type: 'token', delta: 'x' },
      { type: 'done', model: 'm', done_reason: 'length' },
    ]);
  });

  it('emits upstream_malformed on an unparseable SSE frame', async () => {
    const body = streamOf(['data: {not json\n\n']);
    const events = await collect(
      streamLocalChat(
        'llama-cpp',
        { messages: [{ role: 'user', content: 'hi' }] },
        { fetchFn: fetchReturning(body), baseUrl: 'http://x', model: 'm' },
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      code: 'upstream_malformed',
      runtime: 'llama-cpp',
    });
  });

  it('emits upstream_malformed when the stream ends with no terminal signal', async () => {
    const body = streamOf([sseChunk('partial')]);
    const events = await collect(
      streamLocalChat(
        'llama-cpp',
        { messages: [{ role: 'user', content: 'hi' }] },
        { fetchFn: fetchReturning(body), baseUrl: 'http://x', model: 'm' },
      ),
    );
    expect(events[0]).toEqual({ type: 'token', delta: 'partial' });
    expect(events[1]).toMatchObject({ type: 'error', code: 'upstream_malformed' });
  });
});

// ── Ollama NDJSON parsing ──────────────────────────────────────────────────

describe('streamLocalChat — ollama (NDJSON)', () => {
  it('emits token events then a done event with eval counts', async () => {
    const body = streamOf([
      `${JSON.stringify({ model: 'qwen3:4b-ctx4k', message: { role: 'assistant', content: 'He' }, done: false })}\n`,
      `${JSON.stringify({ model: 'qwen3:4b-ctx4k', message: { role: 'assistant', content: 'llo' }, done: false })}\n`,
      `${JSON.stringify({ model: 'qwen3:4b-ctx4k', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 9, eval_count: 2 })}\n`,
    ]);
    const events = await collect(
      streamLocalChat(
        'ollama',
        { messages: [{ role: 'user', content: 'hi' }] },
        { fetchFn: fetchReturning(body), baseUrl: 'http://ollama:11434', model: 'qwen3:4b-ctx4k' },
      ),
    );
    expect(events).toEqual([
      { type: 'token', delta: 'He' },
      { type: 'token', delta: 'llo' },
      {
        type: 'done',
        model: 'qwen3:4b-ctx4k',
        done_reason: 'stop',
        prompt_eval_count: 9,
        eval_count: 2,
      },
    ]);
  });

  it('POSTs stream:true to /api/chat with options passed through', async () => {
    const captured: { url?: string; body?: string } = {};
    const fetchFn: typeof fetch = async (url, init) => {
      captured.url = url as string;
      captured.body = init?.body as string;
      return new Response(streamOf([`${JSON.stringify({ model: 'm', done: true })}\n`]), {
        status: 200,
      });
    };
    await collect(
      streamLocalChat(
        'ollama',
        { messages: [{ role: 'user', content: 'hi' }], options: { num_predict: 128 } },
        { fetchFn, baseUrl: 'http://ollama:11434', model: 'm' },
      ),
    );
    expect(captured.url).toBe('http://ollama:11434/api/chat');
    const sent = JSON.parse(captured.body ?? '{}');
    expect(sent.stream).toBe(true);
    expect(sent.options).toEqual({ num_predict: 128 });
  });

  it('emits upstream_malformed when the stream ends without done:true', async () => {
    const body = streamOf([
      `${JSON.stringify({ model: 'm', message: { role: 'assistant', content: 'x' }, done: false })}\n`,
    ]);
    const events = await collect(
      streamLocalChat(
        'ollama',
        { messages: [{ role: 'user', content: 'hi' }] },
        { fetchFn: fetchReturning(body), baseUrl: 'http://x', model: 'm' },
      ),
    );
    expect(events[0]).toEqual({ type: 'token', delta: 'x' });
    expect(events[1]).toMatchObject({
      type: 'error',
      code: 'upstream_malformed',
      runtime: 'ollama',
    });
  });
});

// ── local-only / box-unavailable semantics (DR-53 / SM-73) ──────────────────

describe('streamLocalChat — local-unavailable (DR-53 / SM-73)', () => {
  it('emits local_unavailable when the upstream fetch throws (box down)', async () => {
    const fetchFn: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const events = await collect(
      streamLocalChat(
        'llama-cpp',
        { messages: [{ role: 'user', content: 'hi' }] },
        { fetchFn, baseUrl: 'http://llama-cpp:8080', model: 'm' },
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      code: 'local_unavailable',
      runtime: 'llama-cpp',
    });
  });

  it('emits local_unavailable on a non-2xx upstream status', async () => {
    const fetchFn: typeof fetch = async () => new Response('model not loaded', { status: 503 });
    const events = await collect(
      streamLocalChat(
        'ollama',
        { messages: [{ role: 'user', content: 'hi' }] },
        { fetchFn, baseUrl: 'http://ollama:11434', model: 'm' },
      ),
    );
    expect(events[0]).toMatchObject({
      type: 'error',
      code: 'local_unavailable',
      detail: expect.stringContaining('503'),
    });
  });

  it('a clean empty completion is a done with no token events (not an error)', async () => {
    // Distinct from local_unavailable: the box answered, the model said nothing.
    const body = streamOf([
      `${JSON.stringify({ model: 'm', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' })}\n`,
    ]);
    const events = await collect(
      streamLocalChat(
        'ollama',
        { messages: [{ role: 'user', content: 'hi' }] },
        { fetchFn: fetchReturning(body), baseUrl: 'http://x', model: 'm' },
      ),
    );
    expect(events).toEqual([{ type: 'done', model: 'm', done_reason: 'stop' }]);
    expect(events.some((e) => e.type === 'token')).toBe(false);
  });
});

// ── SSE serializer ──────────────────────────────────────────────────────────

describe('toSseFrame', () => {
  it('formats a token event as a named SSE frame', () => {
    expect(toSseFrame({ type: 'token', delta: 'Hi' })).toBe(
      'event: token\ndata: {"delta":"Hi"}\n\n',
    );
  });

  it('formats a done event with metadata', () => {
    expect(toSseFrame({ type: 'done', model: 'm', done_reason: 'stop', eval_count: 3 })).toBe(
      'event: done\ndata: {"model":"m","done_reason":"stop","eval_count":3}\n\n',
    );
  });

  it('formats an error event', () => {
    const runtime: RuntimeKind = 'llama-cpp';
    expect(toSseFrame({ type: 'error', code: 'local_unavailable', detail: 'down', runtime })).toBe(
      'event: error\ndata: {"code":"local_unavailable","detail":"down","runtime":"llama-cpp"}\n\n',
    );
  });
});

describe('sseStreamFromEvents', () => {
  async function* gen(events: StreamEvent[]): AsyncGenerator<StreamEvent, void, unknown> {
    for (const e of events) yield e;
  }

  it('serializes a full token→done sequence and closes after done', async () => {
    const stream = sseStreamFromEvents(
      gen([
        { type: 'token', delta: 'Hi' },
        { type: 'token', delta: '!' },
        { type: 'done', model: 'm', done_reason: 'stop' },
      ]),
      'llama-cpp',
    );
    const text = await drainSse(stream);
    expect(text).toBe(
      'event: token\ndata: {"delta":"Hi"}\n\n' +
        'event: token\ndata: {"delta":"!"}\n\n' +
        'event: done\ndata: {"model":"m","done_reason":"stop"}\n\n',
    );
  });

  it('closes the stream after a terminal error frame', async () => {
    const stream = sseStreamFromEvents(
      gen([{ type: 'error', code: 'local_unavailable', detail: 'down', runtime: 'ollama' }]),
      'ollama',
    );
    const text = await drainSse(stream);
    expect(text).toBe(
      'event: error\ndata: {"code":"local_unavailable","detail":"down","runtime":"ollama"}\n\n',
    );
  });

  it('uses the passed runtime in the defensive malformed-stream error frame', async () => {
    // biome-ignore lint/correctness/useYield: fixture throws on first next() to drive the catch path
    async function* boom(): AsyncGenerator<StreamEvent, void, unknown> {
      throw new Error('relay blew up');
    }
    const stream = sseStreamFromEvents(boom(), 'ollama');
    const text = await drainSse(stream);
    expect(text).toBe(
      'event: error\ndata: {"code":"upstream_malformed","detail":"relay blew up","runtime":"ollama"}\n\n',
    );
  });

  it('SSE_HEADERS declares text/event-stream and disables proxy buffering', () => {
    expect(SSE_HEADERS['content-type']).toContain('text/event-stream');
    expect(SSE_HEADERS['x-accel-buffering']).toBe('no');
  });
});

// ── option mapping parity ────────────────────────────────────────────────────

describe('mapLlamaCppOptions', () => {
  it('mirrors the non-streaming num_predict → max_tokens mapping', () => {
    expect(
      __test.mapLlamaCppOptions({ num_predict: 512, temperature: 0.5, top_p: 0.9, stop: ['x'] }),
    ).toEqual({
      max_tokens: 512,
      temperature: 0.5,
      top_p: 0.9,
      stop: ['x'],
    });
  });

  it('returns an empty object for undefined options', () => {
    expect(__test.mapLlamaCppOptions(undefined)).toEqual({});
  });
});
