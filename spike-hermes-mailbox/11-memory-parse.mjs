// Spike §4.4 — parse a tegrastats log → peak RAM used, free headroom at peak,
// and the SM-97 verdict.
//
//   node 11-memory-parse.mjs out/s2-tegrastats.log
//
// tegrastats RAM field looks like:  "RAM 6234/7620MB (lfb ...)"
// We take used/total per line, find the peak used, and report total-peak as
// the free headroom at peak. Also flags any OOM marker.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node 11-memory-parse.mjs <tegrastats.log>');
  process.exit(1);
}
const text = readFileSync(file, 'utf8');
const re = /RAM\s+(\d+)\/(\d+)\s*MB/g;
let m, total = 0, peakUsed = 0, samples = 0;
while ((m = re.exec(text)) !== null) {
  const used = Number(m[1]);
  total = Math.max(total, Number(m[2]));
  peakUsed = Math.max(peakUsed, used);
  samples++;
}
if (samples === 0) {
  console.error(`No "RAM x/yMB" lines found in ${file}. Is this a tegrastats log?`);
  process.exit(1);
}
const oom = /Out of memory|oom-kill|OOMKilled|Killed process/i.test(text);
const freeAtPeak = total - peakUsed;

const SM97 = oom || freeAtPeak < 200
  ? { verdict: 'Q1 FAIL', detail: 'RED — Hermes is T3-only; T2-cloud SKU ships without it' }
  : freeAtPeak < 500
    ? { verdict: 'Q1 MARGINAL', detail: 'record as ship-risk; run §4.5 classifier-drop variant before any T2 commit' }
    : { verdict: 'Q1 PASS', detail: 'proceed to Q2 (draft A/B)' };

console.log('--- SM-97 memory result ---');
console.log(`file:            ${file}`);
console.log(`samples:         ${samples}`);
console.log(`total RAM:       ${total} MB`);
console.log(`peak used:       ${peakUsed} MB`);
console.log(`free at peak:    ${freeAtPeak} MB`);
console.log(`OOM marker seen: ${oom ? 'YES — automatic FAIL' : 'no'}`);
console.log(`\nVERDICT: ${SM97.verdict}\n  → ${SM97.detail}`);
console.log('\nThresholds: >=500MB PASS | 200-500MB MARGINAL | <200MB or OOM FAIL');
