// Spec 002 FR7b (Stage 2b-2) — few-shot exemplar selection + prompt injection.
// Pure functions only (no DB): selectExemplars ranking/cap, exemplarCap env
// handling, and the renderExemplarSection / buildPrompt injection contract.

import { afterEach, describe, expect, it } from 'vitest';
import {
  type ClassificationExemplar,
  DEFAULT_EXEMPLAR_CAP,
  exemplarCap,
  selectExemplars,
} from '@/lib/classification/exemplars';
import { buildPrompt, renderExemplarSection } from '@/lib/classification/prompt';

const ex = (snippet: string, bucket: ClassificationExemplar['bucket']): ClassificationExemplar => ({
  snippet,
  bucket,
});

describe('exemplarCap', () => {
  afterEach(() => {
    delete process.env.CLASSIFY_FEWSHOT_CAP;
  });
  it('defaults to DEFAULT_EXEMPLAR_CAP when unset/blank', () => {
    expect(exemplarCap()).toBe(DEFAULT_EXEMPLAR_CAP);
    process.env.CLASSIFY_FEWSHOT_CAP = '   ';
    expect(exemplarCap()).toBe(DEFAULT_EXEMPLAR_CAP);
  });
  it('clamps to the hard max (10) and floors fractions', () => {
    process.env.CLASSIFY_FEWSHOT_CAP = '50';
    expect(exemplarCap()).toBe(10);
    process.env.CLASSIFY_FEWSHOT_CAP = '4.9';
    expect(exemplarCap()).toBe(4);
  });
  it('<= 0 disables few-shot; a bad value falls back to default', () => {
    process.env.CLASSIFY_FEWSHOT_CAP = '0';
    expect(exemplarCap()).toBe(0);
    process.env.CLASSIFY_FEWSHOT_CAP = 'nope';
    expect(exemplarCap()).toBe(DEFAULT_EXEMPLAR_CAP);
  });
});

describe('selectExemplars (pure ranking + cap)', () => {
  it('empty input or cap<=0 → []', () => {
    expect(selectExemplars([], { cap: 5 })).toEqual([]);
    expect(selectExemplars([ex('a', 'spam')], { cap: 0 })).toEqual([]);
  });

  it('caps to the requested K', () => {
    const cands = Array.from({ length: 20 }, (_, i) => ex(`snippet ${i}`, 'notification'));
    expect(selectExemplars(cands, { cap: 6 })).toHaveLength(6);
  });

  it('floats senderPrior-bucket exemplars to the top', () => {
    const cands = [
      ex('alpha', 'marketing_promo'),
      ex('bravo', 'internal'),
      ex('charlie', 'receipt'),
    ];
    const out = selectExemplars(cands, { senderPrior: 'internal', cap: 3 });
    expect(out[0].bucket).toBe('internal');
  });

  it('ranks by subject keyword overlap when no prior match', () => {
    const cands = [
      ex('a quarterly payroll run summary', 'notification'),
      ex('please review the signed vendor contract', 'contract_legal'),
    ];
    const out = selectExemplars(cands, { subject: 'vendor contract signature needed', cap: 1 });
    expect(out[0].bucket).toBe('contract_legal');
  });

  it('keeps recent-first order on ties (stable)', () => {
    const cands = [ex('zzz', 'spam'), ex('yyy', 'spam'), ex('xxx', 'spam')];
    // no prior, no subject overlap → all ties → original (recent-first) order preserved
    const out = selectExemplars(cands, { cap: 3 });
    expect(out.map((o) => o.snippet)).toEqual(['zzz', 'yyy', 'xxx']);
  });
});

describe('renderExemplarSection / buildPrompt injection contract', () => {
  const input = { from: 'a@b.com', subject: 'hi', body: 'hello' };

  it('empty exemplars → empty section (prompt unchanged)', () => {
    expect(renderExemplarSection()).toBe('');
    expect(renderExemplarSection([])).toBe('');
    expect(buildPrompt(input, 'Acme', undefined, [])).not.toContain('Examples —');
  });

  it('renders labeled [bucket] snippet lines', () => {
    const section = renderExemplarSection([
      { snippet: 'You got paid on Reverb', bucket: 'receipt' },
      { snippet: 'Message about a Strat', bucket: 'sales_lead' },
    ]);
    expect(section).toContain('Examples —');
    expect(section).toContain('1. [receipt] You got paid on Reverb');
    expect(section).toContain('2. [sales_lead] Message about a Strat');
  });

  it('buildPrompt injects the section AND keeps the category list + JSON instruction', () => {
    const p = buildPrompt(input, 'Acme', 'internal', [
      { snippet: 'team sync notes', bucket: 'internal' },
    ]);
    expect(p).toContain('Examples —');
    expect(p).toContain('[internal] team sync notes');
    expect(p).toContain('Classify the email into exactly one of these');
    expect(p).toContain('Output a single JSON object');
    expect(p).toContain('Prior:'); // senderPrior still rendered alongside exemplars
  });

  it('caps each snippet length to protect the ctx window', () => {
    const long = 'x'.repeat(1000);
    const section = renderExemplarSection([{ snippet: long, bucket: 'spam' }]);
    // The snippet is capped at 240 chars — the untruncated 1000-char run never
    // appears (the rest of the section is the fixed heading + line prefix).
    expect(section).not.toContain('x'.repeat(241));
    expect(section).toContain('x'.repeat(240));
  });
});
