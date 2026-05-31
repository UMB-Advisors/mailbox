// Spike §5.1 / §5.3 — run the draft A/B over a frozen eval set.
//
//   node 22-run-ab.mjs out/eval-set.jsonl
//
//   Arm A (control)   : MailBOX prompt (draft-prompt.mjs mirror) → cloud /api/chat
//   Arm B (treatment) : same inbound → `hermes -z` (cloud reasoning + gbrain voice memory)
//
// Fairness: set HERMES_MODEL/HERMES_PROVIDER so arm B's underlying model ==
// arm A's DRAFT_CLOUD_MODEL. If they cannot be matched, that is a recorded
// confound (spike §7). Runs SEQUENTIALLY — this is NOT the SM-97 test, so we
// avoid arm-vs-arm memory contention skewing latency.
//
// Env:
//   OLLAMA_CLOUD_BASE_URL   (e.g. https://ollama.com)      [required for A]
//   OLLAMA_CLOUD_API_KEY                                    [required for A]
//   DRAFT_CLOUD_MODEL       default gpt-oss:120b
//   HERMES_BIN              default hermes
//   HERMES_MODEL            (match DRAFT_CLOUD_MODEL's underlying model)
//   HERMES_PROVIDER
//   PERSONA_JSON            optional path to a persona override JSON
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { assemblePrompt } from './draft-prompt.mjs';

const evalPath = process.argv[2];
if (!evalPath) { console.error('usage: node 22-run-ab.mjs <eval-set.jsonl>'); process.exit(1); }

const OUT = process.env.OUT_DIR || './out';
const DRAFTS = `${OUT}/drafts`;
mkdirSync(DRAFTS, { recursive: true });

const CLOUD_BASE = process.env.OLLAMA_CLOUD_BASE_URL;
const CLOUD_KEY = process.env.OLLAMA_CLOUD_API_KEY;
const CLOUD_MODEL = process.env.DRAFT_CLOUD_MODEL || 'gpt-oss:120b';
const HERMES_BIN = process.env.HERMES_BIN || 'hermes';
const HERMES_MODEL = process.env.HERMES_MODEL || '';
const HERMES_PROVIDER = process.env.HERMES_PROVIDER || '';
const persona = process.env.PERSONA_JSON && existsSync(process.env.PERSONA_JSON)
  ? JSON.parse(readFileSync(process.env.PERSONA_JSON, 'utf8')) : {};

if (!CLOUD_BASE || !CLOUD_KEY) {
  console.error('Arm A needs OLLAMA_CLOUD_BASE_URL + OLLAMA_CLOUD_API_KEY (source MailBOX .env).');
  process.exit(1);
}
if (!HERMES_MODEL) {
  console.warn('WARN: HERMES_MODEL unset — arm B uses Hermes\' default model. For a valid NC-41');
  console.warn('      result both arms MUST share the same underlying model. Recording as a confound.');
}

function stripThink(s) { return (s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim(); }

async function armA(item) {
  const { messages, max_tokens, temperature } = assemblePrompt({
    from_addr: item.from_addr, to_addr: item.to_addr, subject: item.subject,
    body_text: item.body_text, category: item.category, confidence: item.confidence,
    persona,
  });
  const t0 = Date.now();
  const res = await fetch(new URL('/api/chat', CLOUD_BASE), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CLOUD_KEY}` },
    body: JSON.stringify({ model: CLOUD_MODEL, messages, stream: false,
      options: { temperature, num_predict: max_tokens } }),
    signal: AbortSignal.timeout(90_000),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`cloud ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return { body: stripThink(json.message?.content ?? ''), latency_ms: ms };
}

function armB(item) {
  // Hand Hermes the same task; let gbrain memory + skills add the value.
  const prompt = [
    'Draft a reply to the email below in my voice. Use my past sent emails in your',
    'memory to match how I write. Do not invent facts; use [confirm with operator: X]',
    'for anything you are unsure of. Return ONLY the reply body — no subject, no headers.',
    '',
    `From: ${item.from_addr}`, `Subject: ${item.subject}`, '', (item.body_text || '').slice(0, 6000),
  ].join('\n');
  const args = ['-z', prompt, '--yolo'];
  if (HERMES_MODEL) args.push('-m', HERMES_MODEL);
  if (HERMES_PROVIDER) args.push('--provider', HERMES_PROVIDER);
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(HERMES_BIN, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const ms = Date.now() - t0;
      if (err) resolve({ body: '', latency_ms: ms, error: String(err.message || err), stderr: (stderr || '').slice(0, 300) });
      else resolve({ body: stripThink(stdout), latency_ms: ms });
    });
  });
}

const items = readFileSync(evalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log(`A/B over ${items.length} emails — A=${CLOUD_MODEL}  B=hermes(${HERMES_MODEL || 'default'})`);
const results = [];
let i = 0;
for (const item of items) {
  i++;
  const id = item.message_id || `item-${i}`;
  let a, b;
  try { a = await armA(item); } catch (e) { a = { body: '', latency_ms: null, error: String(e.message || e) }; }
  b = await armB(item);
  writeFileSync(`${DRAFTS}/${i.toString().padStart(3, '0')}-${id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}-A.txt`, a.body || `(error: ${a.error})`);
  writeFileSync(`${DRAFTS}/${i.toString().padStart(3, '0')}-${id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}-B.txt`, b.body || `(error: ${b.error})`);
  results.push({ idx: i, message_id: id, category: item.category, subject: item.subject,
    from_addr: item.from_addr, body_text: item.body_text,
    A: a, B: b });
  console.log(`  [${i}/${items.length}] ${item.category}  A=${a.latency_ms ?? 'ERR'}ms  B=${b.latency_ms ?? 'ERR'}ms`);
}
writeFileSync(`${OUT}/results.jsonl`, results.map((r) => JSON.stringify(r)).join('\n') + '\n');

const lat = (arm) => { const v = results.map((r) => r[arm].latency_ms).filter((x) => x != null); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null; };
console.log(`\nwrote ${OUT}/results.jsonl + ${DRAFTS}/*.txt`);
console.log(`mean latency:  A=${lat('A')}ms  B=${lat('B')}ms  (Δ = cost of the Hermes hop)`);
console.log('next: node 23-rate.mjs sheet   → blind-rate, then  node 23-rate.mjs score');
