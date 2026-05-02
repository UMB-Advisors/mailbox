// dashboard/lib/rag/excerpt.ts
//
// STAQPRO-190 — body excerpt builder. The Qdrant `email_messages` payload
// caps `body_excerpt` to keep retrieval responses small (Qdrant memory
// budget + 4k Qwen3 prompt context budget per DR-18).
//
// Strategy: take the first N characters after collapsing whitespace +
// stripping signatures and quoted reply blocks. Keeping this naive and
// portable rather than pulling in a full email-parsing dep — re-evaluate
// when tuning retrieval quality in STAQPRO-191/192.
//
// STAQPRO-193: PII scrub (US phone, SSN, credit-card-ish) is applied here,
// after the structural strip and before the cap, so retrieval payloads +
// embedding inputs are scrubbed in one place. Original bodies in Postgres
// are not touched.

import { scrubPII } from './scrub';

const DEFAULT_EXCERPT_CHAR_CAP = Number(process.env.EMBED_EXCERPT_CHAR_CAP ?? 800);

export function buildBodyExcerpt(
  body: string | null | undefined,
  cap = DEFAULT_EXCERPT_CHAR_CAP,
): string {
  if (!body) return '';
  let s = body;

  // Drop classic Gmail-style quoted reply blocks: lines starting with '>' or
  // a "On ... wrote:" block. We only need to drop down to the operator's
  // current message; deeper history is already captured as separate
  // messages.
  const onWroteIdx = s.search(/\n+On .{0,200}wrote:[\s\S]*$/i);
  if (onWroteIdx > 0) s = s.slice(0, onWroteIdx);
  s = s
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n');

  // Drop common signature delimiters.
  const sigIdx = s.search(/\n--\s*\n/);
  if (sigIdx > 0) s = s.slice(0, sigIdx);

  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();

  // STAQPRO-193: scrub PII before the cap so the redaction tokens are part
  // of the embedded payload (not chopped mid-token).
  s = scrubPII(s).text;

  return s.slice(0, cap);
}

// Compose embedding input from subject + body excerpt. Subject is heavily
// weighted in short emails so we prefix it; nomic-embed-text:v1.5 handles
// either form fine in our smoke tests.
export function buildEmbeddingInput(
  subject: string | null | undefined,
  bodyExcerpt: string,
): string {
  const sub = (subject ?? '').trim();
  if (!sub) return bodyExcerpt;
  if (!bodyExcerpt) return sub;
  return `Subject: ${sub}\n\n${bodyExcerpt}`;
}
