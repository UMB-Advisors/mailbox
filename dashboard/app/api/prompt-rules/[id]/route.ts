import { type NextRequest, NextResponse } from 'next/server';
import { parseJson, parseParams } from '@/lib/middleware/validate';
import { deletePromptRule, updatePromptRule } from '@/lib/queries-prompt-rules';
import { promptRuleIdParamSchema, promptRuleUpdateSchema } from '@/lib/schemas/prompt-rules';

// MBOX-162 P5b — edit / remove a single drafting guideline.
//
// PATCH  /api/prompt-rules/[id] → { rule } | 404. Content edits bump version;
//                                 an enabled-only toggle does not.
// DELETE /api/prompt-rules/[id] → { deleted: true, id } | 404.

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const p = parseParams(params, promptRuleIdParamSchema);
  if (!p.ok) return p.response;
  const parsed = await parseJson(request, promptRuleUpdateSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const rule = await updatePromptRule(p.data.id, parsed.data);
    if (!rule) {
      return NextResponse.json({ error: 'not_found', id: p.data.id }, { status: 404 });
    }
    return NextResponse.json({ rule });
  } catch (error) {
    console.error(`PATCH /api/prompt-rules/${p.data.id} failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const p = parseParams(params, promptRuleIdParamSchema);
  if (!p.ok) return p.response;

  try {
    const deleted = await deletePromptRule(p.data.id);
    if (!deleted) {
      return NextResponse.json({ error: 'not_found', id: p.data.id }, { status: 404 });
    }
    return NextResponse.json({ deleted: true, id: p.data.id });
  } catch (error) {
    console.error(`DELETE /api/prompt-rules/${p.data.id} failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
