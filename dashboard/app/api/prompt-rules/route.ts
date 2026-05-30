import { type NextRequest, NextResponse } from 'next/server';
import { parseJson } from '@/lib/middleware/validate';
import { createPromptRule, listPromptRules } from '@/lib/queries-prompt-rules';
import { promptRuleCreateSchema } from '@/lib/schemas/prompt-rules';

// MBOX-162 P5b — operator drafting guidelines (basic_auth gated by Caddy; not
// under /api/internal). Backs the Guidelines tab of /settings/tuning and the
// rulesSystemBlock prompt injection.
//
// GET  /api/prompt-rules → { rules: PromptRule[] }
// POST /api/prompt-rules → { rule: PromptRule } (version 1, enabled)

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const rules = await listPromptRules();
    return NextResponse.json({ rules });
  } catch (error) {
    console.error('GET /api/prompt-rules failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = await parseJson(request, promptRuleCreateSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const rule = await createPromptRule({
      scope: parsed.data.scope,
      rule: parsed.data.rule,
      rationale: parsed.data.rationale,
      created_by: 'operator',
    });
    return NextResponse.json({ rule });
  } catch (error) {
    console.error('POST /api/prompt-rules failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
