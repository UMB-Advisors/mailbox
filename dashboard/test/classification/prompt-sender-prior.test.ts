// Spec 002 FR7 (Stage 2b-1) — buildPrompt `senderPrior` bias-hint plumbing.
// A bias rule injects a reconcilable prior, NOT a hard rule (the MBOX-370 fix).

import { describe, expect, it } from 'vitest';
import { buildPrompt } from '@/lib/classification/prompt';

const input = { from: 'a@b.com', subject: 'hi', body: 'hello' };

describe('buildPrompt senderPrior hint', () => {
  it('omits the prior line when no senderPrior is given (unchanged prompt)', () => {
    const p = buildPrompt(input, 'Acme');
    expect(p).not.toContain('Prior:');
  });

  it('injects a reconcilable prior the model can override', () => {
    const p = buildPrompt(input, 'Acme', 'internal');
    expect(p).toContain('Prior:');
    expect(p).toContain('"internal"');
    expect(p).toMatch(/hint, not a rule/i);
  });

  it('still emits the full category list + JSON instruction + Email block', () => {
    const p = buildPrompt(input, 'Acme', 'internal');
    expect(p).toContain('Classify the email into exactly one of these');
    expect(p).toContain('Output a single JSON object');
    expect(p).toContain('Email:');
  });
});
