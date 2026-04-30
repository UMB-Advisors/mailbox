// Strip Qwen3 <think> tokens (MAIL-07) and parse classifier JSON output.
// Hard fallback to {category: 'unknown', confidence: 0} on parse failure (D-06).

import { CATEGORIES, type Category } from './prompt';

export interface ClassificationResult {
  category: Category;
  confidence: number;
  json_parse_ok: boolean;
  think_stripped: boolean;
  raw_output: string;
}

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
// Sometimes the model leaves an unclosed <think> open; strip everything up to
// the first '{' if a <think> tag remains after the block-strip pass.
const UNCLOSED_THINK_PREFIX = /^[\s\S]*?<think>[\s\S]*?(?=\{)/i;

const CATEGORY_SET = new Set<string>(CATEGORIES);

export function normalizeClassifierOutput(raw: string): ClassificationResult {
  const safe = raw ?? '';
  const blockMatched = THINK_BLOCK.test(safe);
  let cleaned = safe.replace(THINK_BLOCK, '');
  const prefixMatched = UNCLOSED_THINK_PREFIX.test(cleaned);
  if (prefixMatched) cleaned = cleaned.replace(UNCLOSED_THINK_PREFIX, '');
  const think_stripped = blockMatched || prefixMatched;

  const fenceStripped = cleaned
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();

  const firstBrace = fenceStripped.indexOf('{');
  const lastBrace = fenceStripped.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    return fallback(safe, think_stripped);
  }

  const slice = fenceStripped.slice(firstBrace, lastBrace + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return fallback(safe, think_stripped);
  }

  if (!parsed || typeof parsed !== 'object') {
    return fallback(safe, think_stripped);
  }

  const obj = parsed as Record<string, unknown>;
  const rawCategory = typeof obj.category === 'string' ? obj.category : '';
  const rawConfidence = obj.confidence;

  const category: Category = CATEGORY_SET.has(rawCategory)
    ? (rawCategory as Category)
    : 'unknown';

  let confidence =
    typeof rawConfidence === 'number'
      ? rawConfidence
      : typeof rawConfidence === 'string'
        ? Number.parseFloat(rawConfidence)
        : NaN;
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;

  return {
    category,
    confidence,
    json_parse_ok: true,
    think_stripped,
    raw_output: safe,
  };
}

function fallback(raw: string, think_stripped: boolean): ClassificationResult {
  return {
    category: 'unknown',
    confidence: 0,
    json_parse_ok: false,
    think_stripped,
    raw_output: raw,
  };
}
