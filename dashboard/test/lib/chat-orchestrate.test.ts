import { describe, expect, it, vi } from 'vitest';
import { type ChatSendDeps, type ChatTurnEvent, runChatTurn } from '@/lib/chat/orchestrate';
import type { StreamEvent } from '@/lib/llm/types';
import type { ChatRetrievalResult } from '@/lib/rag/chat-retrieve';
import type { ChatMessage } from '@/lib/types';

// MBOX-287 — orchestration tests. Drive runChatTurn with mocked retrieval,
// streaming, and persistence; assert the emitted ChatTurnEvent sequence and the
// persisted assistant turn. Hermetic — no DB, no on-box llama.cpp (the on-box
// SSE framing + first-token latency are flagged for M1/M2 validation).

function fakeAssistantRow(id: number): ChatMessage {
  return {
    id,
    conversation_id: 1,
    role: 'assistant',
    content: 'persisted',
    model: 'qwen3-4b-ctx4k',
    input_tokens: 10,
    output_tokens: 5,
    rag_context_refs: [],
    rag_retrieval_reason: 'ok',
    created_at: '2026-05-22T00:00:00Z',
  };
}

// Build a scripted StreamEvent generator.
async function* scriptStream(events: StreamEvent[]): AsyncGenerator<StreamEvent, void, unknown> {
  for (const e of events) yield e;
}

async function collect(
  gen: AsyncGenerator<ChatTurnEvent, void, unknown>,
): Promise<ChatTurnEvent[]> {
  const out: ChatTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const okRetrieval: ChatRetrievalResult = {
  reason: 'ok',
  refs: [
    {
      point_id: '11111111-1111-4111-8111-111111111111',
      message_id: 'm1',
      excerpt: 'x',
      score: 0.8,
    },
  ],
};

function baseDeps(overrides: Partial<ChatSendDeps> = {}): {
  deps: ChatSendDeps;
  appendMessage: ReturnType<typeof vi.fn>;
} {
  const appendMessage = vi.fn(async () => fakeAssistantRow(42));
  const deps: ChatSendDeps = {
    retrieveForChat: async () => okRetrieval,
    getConversationMessages: async () => [],
    appendMessage: appendMessage as unknown as ChatSendDeps['appendMessage'],
    streamChat: () =>
      scriptStream([
        { type: 'token', delta: 'Hel' },
        { type: 'token', delta: 'lo' },
        {
          type: 'done',
          model: 'qwen3-4b-ctx4k',
          done_reason: 'stop',
          prompt_eval_count: 10,
          eval_count: 2,
        },
      ]),
    ...overrides,
  };
  return { deps, appendMessage };
}

describe('runChatTurn — happy path', () => {
  it('relays tokens, emits done then saved, persists user + assistant turns', async () => {
    const { deps, appendMessage } = baseDeps();
    const events = await collect(runChatTurn({ conversationId: 1, content: 'hi' }, deps));

    expect(events.map((e) => e.type)).toEqual(['token', 'token', 'done', 'saved']);

    const saved = events.find((e) => e.type === 'saved');
    expect(saved).toMatchObject({
      type: 'saved',
      assistant_message_id: 42,
      rag_retrieval_reason: 'ok',
    });

    // Two appendMessage calls: user turn, then assistant turn.
    expect(appendMessage).toHaveBeenCalledTimes(2);
    const userCall = appendMessage.mock.calls[0][0];
    const assistantCall = appendMessage.mock.calls[1][0];
    expect(userCall).toMatchObject({ conversation_id: 1, role: 'user', content: 'hi' });
    expect(assistantCall).toMatchObject({
      conversation_id: 1,
      role: 'assistant',
      content: 'Hello',
      model: 'qwen3-4b-ctx4k',
      input_tokens: 10,
      output_tokens: 2,
      rag_retrieval_reason: 'ok',
    });
    // floor-cleared point UUID persisted (mirrors drafts path)
    expect(assistantCall.rag_context_refs).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  it('skipUserPersist=true does not re-persist the user turn', async () => {
    const { deps, appendMessage } = baseDeps();
    await collect(runChatTurn({ conversationId: 1, content: 'hi', skipUserPersist: true }, deps));
    // Only the assistant turn is persisted.
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(appendMessage.mock.calls[0][0]).toMatchObject({ role: 'assistant' });
  });
});

describe('runChatTurn — retrieval gating (SM-74)', () => {
  it('below_floor persists empty rag_context_refs and reports the reason', async () => {
    const { deps, appendMessage } = baseDeps({
      retrieveForChat: async () => ({ reason: 'below_floor', refs: [] }),
    });
    const events = await collect(
      runChatTurn({ conversationId: 1, content: 'hi', skipUserPersist: true }, deps),
    );

    const saved = events.find((e) => e.type === 'saved');
    expect(saved).toMatchObject({
      type: 'saved',
      sources: [],
      rag_retrieval_reason: 'below_floor',
    });

    const assistantCall = appendMessage.mock.calls[0][0];
    expect(assistantCall.rag_context_refs).toEqual([]);
    expect(assistantCall.rag_retrieval_reason).toBe('below_floor');
  });
});

describe('runChatTurn — error handling', () => {
  it('relays a local_unavailable error and does NOT persist an assistant turn', async () => {
    const { deps, appendMessage } = baseDeps({
      streamChat: () =>
        scriptStream([
          { type: 'error', code: 'local_unavailable', detail: 'box down', runtime: 'llama-cpp' },
        ]),
    });
    const events = await collect(
      runChatTurn({ conversationId: 1, content: 'hi', skipUserPersist: true }, deps),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'local_unavailable' });
    // No assistant turn persisted — a half-streamed answer is not history.
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('a stream that ends without done becomes an upstream_malformed error, no persist', async () => {
    const { deps, appendMessage } = baseDeps({
      streamChat: () => scriptStream([{ type: 'token', delta: 'partial' }]),
    });
    const events = await collect(
      runChatTurn({ conversationId: 1, content: 'hi', skipUserPersist: true }, deps),
    );

    expect(events.map((e) => e.type)).toEqual(['token', 'error']);
    expect(events[1]).toMatchObject({ type: 'error', code: 'upstream_malformed' });
    expect(appendMessage).not.toHaveBeenCalled();
  });
});
