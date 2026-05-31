// Spike §5.3 / §5.4 — blind rating + scoring for the draft A/B (NC-41).
//
//   node 23-rate.mjs sheet     # emit a blinded, arm-masked rating sheet + key
//   node 23-rate.mjs score     # aggregate filled ratings → A vs B + NC-41 decision
//
// Blind protocol: each email shows "Draft 1" and "Draft 2" in a per-item
// randomized order, so the rater never knows which is the control. The A/B
// mapping lives only in out/rating-key.json. The rater marks each draft:
//   send  = send-as-is (approval)   |   minor = minor-edit   |   rewrite
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const OUT = process.env.OUT_DIR || './out';
const mode = process.argv[2];
const RESULTS = `${OUT}/results.jsonl`;
const KEY = `${OUT}/rating-key.json`;
const SHEET = `${OUT}/rating-sheet.md`;
const RATINGS = `${OUT}/ratings.csv`;   // rater fills: idx,draft1,draft2  (send|minor|rewrite)

function loadResults() {
  if (!existsSync(RESULTS)) { console.error(`missing ${RESULTS} — run 22-run-ab.mjs first`); process.exit(1); }
  return readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

if (mode === 'sheet') {
  const results = loadResults();
  if (existsSync(KEY)) {
    console.error(`${KEY} already exists — regenerating would rotate the blind key and invalidate any filled ratings. Delete it first to regenerate.`);
    process.exit(1);
  }
  const key = {};
  const out = ['# Blind rating sheet (Hermes spike — NC-41)', '',
    'For each email, mark Draft 1 and Draft 2 as **send** / **minor** / **rewrite**.',
    '`send` = you would send it as-is (this is the approval metric).', '',
    `Record answers in \`${RATINGS}\` as CSV lines:  \`idx,draft1_grade,draft2_grade\``,
    '', '---', ''];
  for (const r of results) {
    const flip = Math.random() < 0.5;            // randomize arm → slot per item
    key[r.idx] = flip ? { draft1: 'B', draft2: 'A' } : { draft1: 'A', draft2: 'B' };
    const d1 = flip ? r.B.body : r.A.body;
    const d2 = flip ? r.A.body : r.B.body;
    out.push(`## ${r.idx}. [${r.category}] ${r.subject || '(no subject)'}`,
      `**From:** ${r.from_addr}`, '', '> ' + (r.body_text || '').slice(0, 800).replace(/\n/g, '\n> '), '',
      '**Draft 1:**', '```', d1 || '(empty)', '```', '',
      '**Draft 2:**', '```', d2 || '(empty)', '```', '',
      `_rate → ${RATINGS}:_  \`${r.idx},<send|minor|rewrite>,<send|minor|rewrite>\``, '', '---', '');
  }
  writeFileSync(KEY, JSON.stringify(key, null, 2));
  writeFileSync(SHEET, out.join('\n'));
  if (!existsSync(RATINGS)) writeFileSync(RATINGS, 'idx,draft1,draft2\n');
  console.log(`wrote ${SHEET} (rater) + ${KEY} (do not peek).`);
  console.log(`fill ${RATINGS}, then: node 23-rate.mjs score`);
  process.exit(0);
}

if (mode === 'score') {
  const results = loadResults();
  if (!existsSync(KEY) || !existsSync(RATINGS)) { console.error('need rating-key.json + ratings.csv (run `sheet` first, then fill ratings.csv)'); process.exit(1); }
  const key = JSON.parse(readFileSync(KEY, 'utf8'));
  const rows = readFileSync(RATINGS, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('idx,'));
  const tally = { A: { send: 0, minor: 0, rewrite: 0, n: 0 }, B: { send: 0, minor: 0, rewrite: 0, n: 0 } };
  for (const line of rows) {
    const [idx, g1, g2] = line.split(',').map((s) => s.trim());
    const k = key[idx]; if (!k) continue;
    for (const [slot, grade] of [['draft1', g1], ['draft2', g2]]) {
      const arm = k[slot]; if (!arm || !['send', 'minor', 'rewrite'].includes(grade)) continue;
      tally[arm][grade]++; tally[arm].n++;
    }
  }
  const rate = (arm) => tally[arm].n ? (tally[arm].send / tally[arm].n) * 100 : 0;
  const rA = rate('A'), rB = rate('B'), delta = rB - rA;
  const lat = (arm) => { const v = results.map((r) => r[arm].latency_ms).filter((x) => x != null); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null; };

  const decision = delta >= 10
    ? 'Hermes IN the draft path → GREEN (if Q1 passed)'
    : delta <= 0
      ? 'Hermes OUT of draft path → AMBER (conversational surface only)'
      : 'within ±10pp → Hermes NOT worth the hop → AMBER (conversational surface only)';

  console.log('--- NC-41 draft A/B result ---');
  console.log(`rated:           A n=${tally.A.n}  B n=${tally.B.n}`);
  console.log(`send-as-is rate: A=${rA.toFixed(1)}%  B=${rB.toFixed(1)}%   Δ(B-A)=${delta.toFixed(1)} pp`);
  console.log(`grade split A:   ${JSON.stringify(tally.A)}`);
  console.log(`grade split B:   ${JSON.stringify(tally.B)}`);
  console.log(`mean latency:    A=${lat('A')}ms  B=${lat('B')}ms`);
  console.log(`\nDECISION (≥10pp bar): ${decision}`);
  console.log('Bar is deliberately high — B adds a hop, latency, and a resident process.');
  process.exit(0);
}

console.error('usage: node 23-rate.mjs <sheet|score>');
process.exit(1);
