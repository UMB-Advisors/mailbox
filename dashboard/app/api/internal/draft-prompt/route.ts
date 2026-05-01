import { type NextRequest, NextResponse } from 'next/server';
import type { Category } from '@/lib/classification/prompt';
import { getPool } from '@/lib/db';
import { getPersonaContext } from '@/lib/drafting/persona-stub';
import { assemblePrompt } from '@/lib/drafting/prompt';
import { pickEndpoint } from '@/lib/drafting/router';
import { parseJson } from '@/lib/middleware/validate';
import { draftPromptBodySchema } from '@/lib/schemas/internal';

export const dynamic = 'force-dynamic';

// D-41 — single source of truth for the drafting prompt. Consumed by
// n8n 04-draft-sub at runtime so the prompt cannot drift between local and
// cloud paths.
//
// Returns the messages payload AND the endpoint/model/credentials chosen by
// router.ts. n8n's HTTP Request node uses the returned baseUrl + apiKey + model
// to call Ollama (local daemon or Ollama Cloud — same /api/chat schema).
//
// POST (not GET) because the response includes secrets (Ollama Cloud API key)
// that should not appear in proxy logs as a query string.

const LOAD_DRAFT_SQL = `
  SELECT
    id,
    from_addr,
    to_addr,
    subject,
    body_text,
    classification_category,
    classification_confidence
  FROM mailbox.drafts
  WHERE id = $1
  LIMIT 1
`;

interface DraftRow {
  id: number;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  body_text: string | null;
  classification_category: Category | null;
  classification_confidence: number | null;
}

export async function POST(req: NextRequest) {
  const b = await parseJson(req, draftPromptBodySchema);
  if (!b.ok) return b.response;
  const { draft_id } = b.data;

  try {
    const pool = getPool();
    const r = await pool.query<DraftRow>(LOAD_DRAFT_SQL, [draft_id]);
    const row = r.rows[0];
    if (!row) {
      return NextResponse.json({ error: `draft ${draft_id} not found` }, { status: 404 });
    }

    if (!row.classification_category) {
      // Fail closed — every draft row should be created post-classify with a
      // category populated. If we got here, the upstream pipeline broke.
      return NextResponse.json(
        {
          error: `draft ${draft_id} has no classification_category — upstream classify did not complete`,
        },
        { status: 422 },
      );
    }

    const persona = await getPersonaContext();
    const confidence = row.classification_confidence ?? 0;

    const assembled = assemblePrompt({
      from_addr: row.from_addr ?? '',
      to_addr: row.to_addr ?? '',
      subject: row.subject ?? '',
      body_text: row.body_text ?? '',
      category: row.classification_category,
      confidence,
      persona,
    });

    const endpoint = pickEndpoint(row.classification_category, confidence);

    return NextResponse.json({
      draft_id,
      // Endpoint config for n8n's HTTP Request node.
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      model: endpoint.model,
      source: endpoint.source,
      display_label: endpoint.display_label,
      // Prompt payload — drop straight into the chat-completions body.
      messages: assembled.messages,
      max_tokens: assembled.max_tokens,
      temperature: assembled.temperature,
    });
  } catch (error) {
    console.error('POST /api/internal/draft-prompt failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
