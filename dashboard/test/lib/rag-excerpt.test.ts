import { describe, expect, it } from 'vitest';
import { buildBodyExcerpt, buildEmbeddingInput } from '@/lib/rag/excerpt';

// STAQPRO-190 — body excerpt strategy. Goal: produce a short, signal-dense
// snippet from a raw email body so the resulting Qdrant payload doesn't
// blow the memory budget or the 4k Qwen3 context budget at retrieval time
// (DR-18).

describe('buildBodyExcerpt — STAQPRO-190', () => {
  it('returns empty string for empty / null input', () => {
    expect(buildBodyExcerpt('')).toBe('');
    expect(buildBodyExcerpt(null)).toBe('');
    expect(buildBodyExcerpt(undefined)).toBe('');
  });

  it('strips classic Gmail "On ... wrote:" reply blocks', () => {
    const body = `Quick yes from me.

On Mon, Apr 28, 2026 at 9:00 AM Sender <s@x.com> wrote:
> Original long thread...
> ...
> ...`;
    const e = buildBodyExcerpt(body);
    expect(e).toBe('Quick yes from me.');
    expect(e).not.toContain('Original');
  });

  it('strips lines starting with > (quoted reply text)', () => {
    const body = `Replying inline:

> Their question
My answer.`;
    const e = buildBodyExcerpt(body);
    expect(e).not.toContain('Their question');
    expect(e).toContain('My answer.');
  });

  it('drops common signature delimiter -- on its own line', () => {
    const body = `Hello there.

--
Regards,
Bob
Phone: 555-1234`;
    const e = buildBodyExcerpt(body);
    expect(e).toBe('Hello there.');
  });

  it('caps at the configured char limit', () => {
    const body = 'x'.repeat(2000);
    const e = buildBodyExcerpt(body, 100);
    expect(e.length).toBe(100);
  });

  it('collapses whitespace runs', () => {
    const body = 'Hello\n\n\n   world  \t  again';
    expect(buildBodyExcerpt(body)).toBe('Hello world again');
  });
});

describe('buildEmbeddingInput — STAQPRO-190', () => {
  it('prefixes a non-empty subject when both present', () => {
    expect(buildEmbeddingInput('Re: order', 'Confirming details.')).toBe(
      'Subject: Re: order\n\nConfirming details.',
    );
  });

  it('returns excerpt alone when subject empty', () => {
    expect(buildEmbeddingInput('', 'Body only.')).toBe('Body only.');
    expect(buildEmbeddingInput(null, 'Body only.')).toBe('Body only.');
  });

  it('returns subject alone when excerpt empty', () => {
    expect(buildEmbeddingInput('Just a subject', '')).toBe('Just a subject');
  });
});
