// STAQPRO-390 — pure-helper tests for the local-model cosine eval harness.
// I/O paths (Pool, fetch, embedText) are not exercised here; this file pins
// the math + arg-parsing behavior so future changes to thresholds, tie band,
// or output shape have a test fail to ground them.

import { describe, expect, it } from 'vitest';
import {
  aggregate,
  classifyWin,
  cosineSimilarity,
  median,
  parseArgs,
} from '@/scripts/local-model-cosine-eval';

describe('cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    const v = [1, 0, 0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('returns -1 for antipodal vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it('returns 0 (not NaN) for mismatched-length inputs', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it('returns 0 (not NaN) for empty inputs', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 (not NaN) for zero-magnitude vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
  });

  it('handles non-normalized vectors correctly', () => {
    // [2,0] and [4,0] are colinear; cosine should still be 1.
    expect(cosineSimilarity([2, 0], [4, 0])).toBeCloseTo(1, 6);
  });
});

describe('classifyWin', () => {
  it('marks candidate winner when delta exceeds tie band', () => {
    expect(classifyWin({ baseline: 0.7, candidate: 0.72 })).toBe('candidate');
  });

  it('marks baseline winner when delta exceeds tie band the other way', () => {
    expect(classifyWin({ baseline: 0.75, candidate: 0.7 })).toBe('baseline');
  });

  it('marks tie within the default ±0.005 band', () => {
    expect(classifyWin({ baseline: 0.7, candidate: 0.703 })).toBe('tie');
    expect(classifyWin({ baseline: 0.7, candidate: 0.697 })).toBe('tie');
  });

  it('marks dropout when either side is null', () => {
    expect(classifyWin({ baseline: null, candidate: 0.7 })).toBe('dropout');
    expect(classifyWin({ baseline: 0.7, candidate: null })).toBe('dropout');
    expect(classifyWin({ baseline: null, candidate: null })).toBe('dropout');
  });

  it('respects a custom tie band', () => {
    expect(classifyWin({ baseline: 0.7, candidate: 0.71 }, 0.02)).toBe('tie');
    expect(classifyWin({ baseline: 0.7, candidate: 0.71 }, 0.001)).toBe('candidate');
  });
});

describe('median', () => {
  it('returns 0 for empty arrays', () => {
    expect(median([])).toBe(0);
  });

  it('returns the middle value for odd-length arrays', () => {
    expect(median([1, 3, 2])).toBe(2);
  });

  it('returns the average of the two middle values for even-length arrays', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('does not mutate the input array', () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe('aggregate', () => {
  it('returns zeroed summary for empty input', () => {
    const s = aggregate([]);
    expect(s.total_rows).toBe(0);
    expect(s.scored_rows).toBe(0);
    expect(s.candidate_win_pct).toBe(0);
  });

  it('counts dropouts separately from decided rows', () => {
    const s = aggregate([
      { baseline: 0.7, candidate: 0.72 }, // candidate wins
      { baseline: 0.75, candidate: 0.7 }, // baseline wins
      { baseline: null, candidate: 0.7 }, // dropout
      { baseline: 0.7, candidate: 0.702 }, // tie (within 0.005)
    ]);
    expect(s.total_rows).toBe(4);
    expect(s.scored_rows).toBe(3);
    expect(s.dropouts).toBe(1);
    expect(s.candidate_wins).toBe(1);
    expect(s.baseline_wins).toBe(1);
    expect(s.ties).toBe(1);
    expect(s.candidate_win_pct).toBe(33.3);
  });

  it('computes mean/median/delta correctly on real-ish numbers', () => {
    const s = aggregate([
      { baseline: 0.6, candidate: 0.7 },
      { baseline: 0.7, candidate: 0.8 },
      { baseline: 0.8, candidate: 0.9 },
    ]);
    expect(s.baseline_mean).toBeCloseTo(0.7, 4);
    expect(s.candidate_mean).toBeCloseTo(0.8, 4);
    expect(s.baseline_median).toBeCloseTo(0.7, 4);
    expect(s.candidate_median).toBeCloseTo(0.8, 4);
    expect(s.mean_delta).toBeCloseTo(0.1, 4);
    expect(s.candidate_wins).toBe(3);
    expect(s.candidate_win_pct).toBe(100);
  });

  it('ignores dropout rows in mean/median', () => {
    const s = aggregate([
      { baseline: null, candidate: 0.99 }, // dropout — must not pull baseline_mean down
      { baseline: 0.5, candidate: 0.5 }, // tie
    ]);
    expect(s.baseline_mean).toBeCloseTo(0.5, 4);
    expect(s.candidate_mean).toBeCloseTo(0.5, 4);
    expect(s.scored_rows).toBe(1);
  });
});

describe('parseArgs', () => {
  it('parses a full happy-path invocation', () => {
    const args = parseArgs([
      '--baseline',
      'qwen3:4b-ctx4k',
      '--candidate',
      'qwen3.5:4b-ctx4k',
      '--limit',
      '50',
      '--run-tag',
      '2026-05-16-A',
    ]);
    expect(args.baseline).toBe('qwen3:4b-ctx4k');
    expect(args.candidate).toBe('qwen3.5:4b-ctx4k');
    expect(args.limit).toBe(50);
    expect(args.run_tag).toBe('2026-05-16-A');
  });

  it('defaults limit to 100 and synthesizes a run_tag when omitted', () => {
    const args = parseArgs(['--baseline', 'a', '--candidate', 'b']);
    expect(args.limit).toBe(100);
    expect(args.run_tag).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-ish
  });

  it('throws when --baseline is missing', () => {
    expect(() => parseArgs(['--candidate', 'b'])).toThrow(/--baseline/);
  });

  it('throws when --candidate is missing', () => {
    expect(() => parseArgs(['--baseline', 'a'])).toThrow(/--candidate/);
  });

  it('throws on non-positive limits', () => {
    expect(() => parseArgs(['--baseline', 'a', '--candidate', 'b', '--limit', '0'])).toThrow(
      /--limit/,
    );
    expect(() => parseArgs(['--baseline', 'a', '--candidate', 'b', '--limit', 'banana'])).toThrow(
      /--limit/,
    );
  });
});
