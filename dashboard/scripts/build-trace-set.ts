#!/usr/bin/env -S npx tsx
// dashboard/scripts/build-trace-set.ts
//
// STAQPRO-340 — export a stable, content-addressed trace set from a live
// appliance's Postgres for use by:
//
//   - STAQPRO-342 (three-way model bake-off)
//   - STAQPRO-343 (DSPy GEPA optimizer baseline)
//   - STAQPRO-344 (LoRA adapter validation)
//
// What this script does NOT do:
//
//   - Synthesize traces for `summarize-thread` / `escalate-to-human` /
//     `classify-and-file`. The v1.0 spec is `draft-reply` only — the other
//     three categories require either human labeling or LLM-synthesized
//     data, both of which are gated on operator approval and tracked in
//     STAQPRO-340.2.
//   - Capture 8K / 16K long-context traces. The current customer #1 corpus
//     doesn't hit 8K+ in a single inbound; the long-context tier is gated on
//     either a larger customer corpus or LLM-augmented thread concatenation
//     (STAQPRO-340.1).
//   - Commit the actual trace JSONL into git. The output directory should be
//     gitignored — `manifest.json` is committed; the `*.trace.json` files
//     live on the operator's workstation. See `eval/t2-traces/v1.0/README.md`.
//
// Privacy: bodies are scrubbed via `lib/rag/scrub.ts:scrubPII` (phone, SSN,
// 16-digit card → tokens). Email addresses, URLs, and names are NOT scrubbed
// per the STAQPRO-193 locked decision — they're legitimate relationship
// signal for retrieval-augmented eval. The operator is responsible for not
// distributing the JSONL outside controlled storage.
//
// Run from inside the dashboard container, with POSTGRES_URL pointing at the
// appliance DB (e.g., via SSH tunnel: `ssh -L 5432:localhost:5432 mailbox1`):
//
//   POSTGRES_URL=postgresql://mailbox:<pw>@localhost:5432/mailbox \
//     npx tsx scripts/build-trace-set.ts \
//       --out eval/t2-traces/v1.0 \
//       --set-version v1.0 \
//       --appliance mailbox1 \
//       --limit 50
//
// Idempotent: re-runs against the same source DB rows produce byte-identical
// trace JSON (modulo the `extracted_at` timestamp in provenance, which the
// script keeps stable when `--extracted-at <iso>` is supplied).

import { createHash } from 'node:crypto';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Pool } from 'pg';
import {
  buildManifest,
  TRACE_FORMAT_VERSION,
  type Trace,
  type TraceManifest,
  type TraceScrubCounts,
  type TraceWithFilename,
  traceFilename,
  traceToCanonicalJson,
} from '../lib/eval/trace-set';
import { scrubPII } from '../lib/rag/scrub';

// =============================================================================
// CLI argument parsing
// =============================================================================

interface ParsedArgs {
  out: string;
  setVersion: string;
  appliance: string;
  limit: number;
  extractedAt: string;
  clean: boolean;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let out = 'eval/t2-traces/v1.0';
  let setVersion = 'v1.0';
  let appliance = process.env.MAILBOX_APPLIANCE_ID ?? 'unknown';
  let limit = 50;
  let extractedAt = new Date().toISOString();
  let clean = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      out = required(argv[i + 1], '--out');
      i++;
      continue;
    }
    if (a === '--set-version') {
      setVersion = required(argv[i + 1], '--set-version');
      i++;
      continue;
    }
    if (a === '--appliance') {
      appliance = required(argv[i + 1], '--appliance');
      i++;
      continue;
    }
    if (a === '--limit') {
      const n = Number(required(argv[i + 1], '--limit'));
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit must be a positive number, got: ${argv[i + 1]}`);
      }
      limit = Math.floor(n);
      i++;
      continue;
    }
    if (a === '--extracted-at') {
      // Lets a re-run produce byte-identical manifest by pinning the
      // provenance timestamp.
      extractedAt = required(argv[i + 1], '--extracted-at');
      i++;
      continue;
    }
    if (a === '--clean') {
      // Delete `*.trace.json` files in the output dir before writing the new
      // set. Off by default to avoid surprise data loss.
      clean = true;
      continue;
    }
    if (a === '--dry-run') {
      // Print what would be written; don't write anything.
      dryRun = true;
      continue;
    }
    throw new Error(`unknown arg: ${a}`);
  }

  return { out, setVersion, appliance, limit, extractedAt, clean, dryRun };
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === '') {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

// =============================================================================
// Source query
// =============================================================================

interface SourceRow {
  sent_history_id: number;
  inbox_id: number;
  inbox_message_id: string;
  inbox_thread_id: string | null;
  inbox_from: string | null;
  inbox_subject: string | null;
  inbox_body: string;
  inbox_classification: string | null;
  inbox_confidence: number | null;
  actual_reply_body: string;
  reply_sent_at: string;
}

/**
 * SQL mirrors `dashboard/scripts/rag-eval-harness.ts:buildSampleSql` so the
 * trace set covers exactly the rows the existing DB-driven eval would have
 * selected — only difference is we cap at `limit` and apply a stratified
 * ORDER BY so categories aren't all from the same time window.
 *
 * Stratification: NULLs sort last in ASC, so unclassified pairs end up at
 * the tail rather than dominating the head. Within each classification the
 * order is by `sent_at` ASC (oldest first) — same convention as the
 * existing harness for reproducibility.
 */
function buildSourceSql(limit: number): string {
  return `
    SELECT
      sh.id                          AS sent_history_id,
      im.id                          AS inbox_id,
      im.message_id                  AS inbox_message_id,
      im.thread_id                   AS inbox_thread_id,
      im.from_addr                   AS inbox_from,
      im.subject                     AS inbox_subject,
      im.body                        AS inbox_body,
      im.classification              AS inbox_classification,
      im.confidence                  AS inbox_confidence,
      sh.draft_sent                  AS actual_reply_body,
      sh.sent_at                     AS reply_sent_at
    FROM mailbox.sent_history sh
    JOIN mailbox.inbox_messages im ON im.id = sh.inbox_message_id
    WHERE sh.source = 'backfill'
      AND sh.inbox_message_id IS NOT NULL
      AND COALESCE(sh.draft_sent, '') <> ''
      AND COALESCE(im.body, '') <> ''
    ORDER BY im.classification ASC NULLS LAST, sh.sent_at ASC
    LIMIT ${Math.max(1, Math.floor(limit))}
  `;
}

// =============================================================================
// Row → Trace transformation
// =============================================================================

interface ScrubbedRow {
  trace: Trace;
}

function rowToTrace(row: SourceRow, appliance: string, extractedAt: string): ScrubbedRow {
  const scrubbedInbox = scrubPII(row.inbox_body);
  const scrubbedReply = scrubPII(row.actual_reply_body);

  const scrub_counts: TraceScrubCounts = {
    phone: scrubbedInbox.counts.phone + scrubbedReply.counts.phone,
    ssn: scrubbedInbox.counts.ssn + scrubbedReply.counts.ssn,
    card: scrubbedInbox.counts.card + scrubbedReply.counts.card,
  };

  const trace: Trace = {
    format_version: TRACE_FORMAT_VERSION,
    workflow_category: 'draft-reply',
    classification: classificationOrNull(row.inbox_classification),
    inbox_message_id: row.inbox_message_id,
    inbox_thread_id: row.inbox_thread_id,
    inbox_from: row.inbox_from,
    inbox_subject: row.inbox_subject,
    inbox_body: scrubbedInbox.text,
    inbox_confidence: row.inbox_confidence,
    actual_reply_body: scrubbedReply.text,
    reply_sent_at: row.reply_sent_at,
    provenance: {
      appliance,
      sent_history_id: row.sent_history_id,
      inbox_id: row.inbox_id,
      extracted_at: extractedAt,
      scrub_counts,
    },
  };

  return { trace };
}

/**
 * Narrow the DB-string-typed classification into the `Category` union or
 * null. The trace schema accepts `string | null` so we don't have to
 * pre-validate against the enum here — but we DO drop empty strings to
 * `null` for consistency with how the live drafter treats them.
 */
function classificationOrNull(raw: string | null): Trace['classification'] {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // Cast is safe: `Category` is a union of strings, the harness already
  // tolerates unrecognized values via `(... as Category | null) ?? 'inquiry'`
  // in generateDraft. Keeping the raw DB value preserves the bake-off's
  // ability to detect classifier drift.
  return trimmed as Trace['classification'];
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const postgresUrl = process.env.POSTGRES_URL;
  if (!postgresUrl) throw new Error('POSTGRES_URL not set');

  console.log(
    `[build-trace-set] out=${args.out} set_version=${args.setVersion} appliance=${args.appliance} limit=${args.limit} dry_run=${args.dryRun}`,
  );

  const pool = new Pool({ connectionString: postgresUrl, max: 2 });
  const rows: SourceRow[] = [];
  try {
    const r = await pool.query<SourceRow>(buildSourceSql(args.limit));
    rows.push(...r.rows);
  } finally {
    await pool.end();
  }
  console.log(`[build-trace-set] selected ${rows.length} source rows`);

  if (rows.length === 0) {
    throw new Error('no rows returned — check sh.source=backfill rows exist in the source DB');
  }

  // Convert rows to traces. Each trace's filename is derived from its
  // SHA-256 (content-addressed), so two rows with identical bytes produce
  // identical filenames — but the SQL dedup on `inbox_message_id` already
  // guarantees that can't happen on real data.
  const tracesWithFilenames: TraceWithFilename[] = rows.map((row) => {
    const { trace } = rowToTrace(row, args.appliance, args.extractedAt);
    return { trace, filename: traceFilename(trace) };
  });

  // Defense against the SHA-prefix-collision corner case (vanishingly
  // unlikely at n=50, but cheap to assert).
  const filenameSet = new Set(tracesWithFilenames.map((t) => t.filename));
  if (filenameSet.size !== tracesWithFilenames.length) {
    throw new Error(
      `trace filename collision detected — bump the prefix length in traceFilename()`,
    );
  }

  const manifest: TraceManifest = buildManifest({
    set_version: args.setVersion,
    source_appliance: args.appliance,
    generated_at: args.extractedAt,
    traces: tracesWithFilenames,
  });

  if (args.dryRun) {
    console.log('[build-trace-set] DRY RUN — would write:');
    for (const t of tracesWithFilenames) {
      console.log(`  ${path.join(args.out, t.filename)}`);
    }
    console.log(`  ${path.join(args.out, 'manifest.json')}`);
    console.log(`[build-trace-set] set_sha256=${manifest.set_sha256}`);
    return;
  }

  await mkdir(args.out, { recursive: true });

  // --clean removes prior `*.trace.json` files in the output dir. Leaves
  // `manifest.json` and `README.md` and any other non-trace files alone.
  if (args.clean) {
    const existing = await readdir(args.out);
    for (const name of existing) {
      if (name.endsWith('.trace.json')) {
        await unlink(path.join(args.out, name));
      }
    }
  }

  for (const { trace, filename } of tracesWithFilenames) {
    const filepath = path.join(args.out, filename);
    await writeFile(filepath, traceToCanonicalJson(trace), 'utf-8');
  }

  const manifestPath = path.join(args.out, 'manifest.json');
  // Manifest gets the same trailing-newline convention as the trace files
  // for tidy diffs.
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  // Echo the SHA over the manifest file itself so the operator can later
  // pin against the exact file (useful for run-tagging in the eval report).
  const manifestSha = createHash('sha256')
    .update(`${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
    .digest('hex');

  console.log(`[build-trace-set] wrote ${tracesWithFilenames.length} trace files`);
  console.log(`[build-trace-set] manifest_sha256=${manifestSha}`);
  console.log(`[build-trace-set] set_sha256=${manifest.set_sha256}`);
  console.log(`[build-trace-set] manifest=${manifestPath}`);
}

// Only run when invoked directly (not when imported by tests).
const isDirect =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /build-trace-set\.(ts|js|mjs|cjs)$/.test(process.argv[1]);

if (isDirect) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export type { ParsedArgs, SourceRow };
// Exports for unit tests
export { buildSourceSql, parseArgs, rowToTrace };
