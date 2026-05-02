// dashboard/lib/rag/kb-chunker.ts
//
// STAQPRO-148 — paragraph-preference fixed-size chunker for KB docs (SOPs,
// price sheets, policies). Custom 50-LOC implementation rather than a
// langchain-text-splitters dep, per Plan agent's stress-test (avoids
// peer-dep churn for v1; the unit tests are the quality gate).
//
// Strategy:
//   1. Split on paragraph boundaries (blank lines).
//   2. Pack paragraphs greedily into chunks until the chunk would exceed
//      `chunkChars`. If a single paragraph already exceeds `chunkChars`,
//      fall back to fixed-size character splits within that paragraph.
//   3. Add `overlapChars` of context from the previous chunk's tail to each
//      new chunk (helps retrieval recall when a relevant span crosses a
//      chunk boundary).
//
// "Tokens" is approximated as 4 chars per token (common nomic-embed/BPE
// average) — the chunker works in characters internally for simplicity but
// callers can pass token-shaped values if they prefer.

const DEFAULT_CHUNK_CHARS = Number(process.env.KB_CHUNK_CHARS ?? 3200); // ≈ 800 tokens
const DEFAULT_OVERLAP_CHARS = Number(process.env.KB_OVERLAP_CHARS ?? 400); // ≈ 100 tokens

// String-built RegExp avoids biome's no-control-chars-in-regex rule on a
// regex literal. Stripping null bytes is intentional — pdf-parse output
// frequently contains them (per the Plan agent's stress-test).
const NULL_BYTE_RE = new RegExp('\\u0000', 'g');

export interface ChunkOptions {
  chunkChars?: number;
  overlapChars?: number;
}

export interface Chunk {
  index: number;
  text: string;
}

// Strip null bytes + normalize whitespace (per Plan agent — pdf-parse
// output is filthy). Keep paragraph breaks (double newline) intact for the
// paragraph-boundary chunker; collapse any other whitespace runs to a
// single space.
export function normalizeForChunking(input: string): string {
  return input
    .replace(NULL_BYTE_RE, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((para) => para.replace(/\s+/g, ' ').trim())
    .filter((para) => para.length > 0)
    .join('\n\n');
}

export function chunkText(input: string, opts: ChunkOptions = {}): Chunk[] {
  const chunkChars = opts.chunkChars ?? DEFAULT_CHUNK_CHARS;
  const overlapChars = opts.overlapChars ?? DEFAULT_OVERLAP_CHARS;

  if (chunkChars <= 0) {
    throw new Error('chunkChars must be > 0');
  }
  if (overlapChars < 0 || overlapChars >= chunkChars) {
    throw new Error('overlapChars must be in [0, chunkChars)');
  }

  const normalized = normalizeForChunking(input);
  if (!normalized) return [];

  // Decompose into paragraphs first; oversized paragraphs are pre-split
  // into chunkChars-sized slices so the greedy packer always sees units it
  // can fit.
  const units: string[] = [];
  for (const para of normalized.split(/\n\n+/)) {
    if (para.length <= chunkChars) {
      units.push(para);
    } else {
      for (let i = 0; i < para.length; i += chunkChars) {
        units.push(para.slice(i, i + chunkChars));
      }
    }
  }

  const chunks: Chunk[] = [];
  let buffer = '';
  let prevTail = '';

  const flush = (): void => {
    if (!buffer.trim()) return;
    const overlap = prevTail ? `${prevTail}\n\n` : '';
    chunks.push({ index: chunks.length, text: (overlap + buffer).trim() });
    prevTail = buffer.slice(Math.max(0, buffer.length - overlapChars));
    buffer = '';
  };

  for (const unit of units) {
    const candidate = buffer ? `${buffer}\n\n${unit}` : unit;
    if (candidate.length <= chunkChars) {
      buffer = candidate;
    } else {
      flush();
      buffer = unit;
    }
  }
  flush();

  return chunks;
}
