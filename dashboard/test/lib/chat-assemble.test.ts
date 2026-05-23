import { describe, expect, it } from 'vitest';
import {
  assembleChatMessages,
  buildContextBlock,
  buildSystemPrompt,
  historyToModelMessages,
} from '@/lib/chat/assemble';
import type { ChatRetrievalResult } from '@/lib/rag/chat-retrieve';
import type { ChatMessage } from '@/lib/types';

// MBOX-287 — pure message-assembly tests. The DR-56 / SM-74 invariant is the
// load-bearing one: no document/grounding claim is constructed when retrieval
// did not clear the floor. These run with no DB and no on-box model.

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 1,
    conversation_id: 1,
    role: 'user',
    content: 'hi',
    model: null,
    input_tokens: null,
    output_tokens: null,
    rag_context_refs: [],
    rag_retrieval_reason: 'none',
    created_at: '2026-05-22T00:00:00Z',
    ...partial,
  };
}

const okRetrieval: ChatRetrievalResult = {
  reason: 'ok',
  refs: [
    {
      point_id: 'p1',
      message_id: 'm1',
      excerpt: 'supplier confirmed Q3 ships on the 14th',
      score: 0.81,
    },
    { point_id: 'p2', message_id: 'm2', excerpt: 'invoice 4471 was paid net-30', score: 0.74 },
  ],
};

const belowFloorRetrieval: ChatRetrievalResult = { reason: 'below_floor', refs: [] };
const embedDownRetrieval: ChatRetrievalResult = { reason: 'embed_unavailable', refs: [] };

describe('buildSystemPrompt — retrieval gating (DR-56 / SM-74)', () => {
  it('grounded prompt only when reason === ok', () => {
    expect(buildSystemPrompt('ok')).toContain('past email messages are provided');
  });

  it.each([
    'below_floor',
    'no_hits',
    'embed_unavailable',
    'qdrant_unavailable',
    'empty_query',
  ] as const)('plain prompt forbids document claims for reason=%s', (reason) => {
    const prompt = buildSystemPrompt(reason);
    expect(prompt).toContain('Do NOT claim');
    expect(prompt).not.toContain('past email messages are provided');
  });
});

describe('buildContextBlock', () => {
  it('renders numbered excerpts when reason === ok', () => {
    const block = buildContextBlock(okRetrieval);
    expect(block).toContain('[1] supplier confirmed Q3');
    expect(block).toContain('[2] invoice 4471');
  });

  it('returns null below the floor (no empty grounding block — SM-74)', () => {
    expect(buildContextBlock(belowFloorRetrieval)).toBeNull();
    expect(buildContextBlock(embedDownRetrieval)).toBeNull();
  });

  it('returns null when ok but refs are empty', () => {
    expect(buildContextBlock({ reason: 'ok', refs: [] })).toBeNull();
  });
});

describe('historyToModelMessages', () => {
  it('preserves order and drops empty/whitespace rows', () => {
    const out = historyToModelMessages([
      msg({ role: 'user', content: 'first' }),
      msg({ role: 'assistant', content: '   ' }), // empty stub — dropped
      msg({ role: 'assistant', content: 'second' }),
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ]);
  });
});

describe('assembleChatMessages', () => {
  it('ok: [system(grounded), ...history, system(context), user]', () => {
    const out = assembleChatMessages({
      history: [msg({ role: 'user', content: 'earlier' })],
      userContent: 'what did the supplier say?',
      retrieval: okRetrieval,
    });
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('past email messages are provided');
    expect(out[1]).toEqual({ role: 'user', content: 'earlier' });
    // context injected as a system turn immediately before the user turn
    expect(out[out.length - 2].role).toBe('system');
    expect(out[out.length - 2].content).toContain('Relevant past messages');
    expect(out[out.length - 1]).toEqual({
      role: 'user',
      content: 'what did the supplier say?',
    });
  });

  it('below floor: no context system turn, plain system prompt (SM-74)', () => {
    const out = assembleChatMessages({
      history: [],
      userContent: 'random question',
      retrieval: belowFloorRetrieval,
    });
    expect(out).toHaveLength(2); // system + user only
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('Do NOT claim');
    expect(out.some((m) => m.content.includes('Relevant past messages'))).toBe(false);
    expect(out[1]).toEqual({ role: 'user', content: 'random question' });
  });
});
