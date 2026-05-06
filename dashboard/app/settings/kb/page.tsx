import { AppNav } from '@/components/AppNav';
import { apiUrl } from '@/lib/api';
import { listKbDocuments } from '@/lib/queries-kb';
import { getTopEditRateCategories, type TopEditRateCategory } from '@/lib/queries-status';
import { reconcileOnce } from '@/lib/rag/kb-reconciler';
import type { KbDocument } from '@/lib/types';
import { CategoryNudgeCard } from './components/CategoryNudgeCard';

export const dynamic = 'force-dynamic';

// STAQPRO-235 (KB Phase 2) — post-onboarding KB nudge UI.
//
// Surfaces the top-3 categories that are bleeding edits (read-only via
// v_override_rate from STAQPRO-233) with category-specific drag-drop
// targets. The operator decides which SOPs to upload — we don't
// auto-recommend (Linus hard-no on scanning). Existing /knowledge-base
// page stays as the catch-all "all my docs" surface; this is the
// metric-driven nudge.
//
// Onboarding state machine is **not** modified — this is post-onboarding
// (per Neo Architect: the operator can't intelligently pick docs on
// day-zero, they need signal first).
//
// Empty-state threshold: each category needs >= 5 disposed drafts in the
// 14-day v_override_rate window before it's offered as a nudge target.
// Below that, render the "come back after your first 20" message.
const MIN_SAMPLE_PER_CATEGORY = 5;
const MIN_TOTAL_FOR_SIGNAL = 20;

export default async function SettingsKbPage() {
  // Lazy reconciler boot hook — same pattern as /knowledge-base. Catches
  // stuck 'processing' rows from dashboard restarts.
  await reconcileOnce();

  let topCategories: ReadonlyArray<TopEditRateCategory> = [];
  let docs: KbDocument[] = [];
  let topErr: string | null = null;
  let docsErr: string | null = null;

  // Pull metrics + docs in parallel. Each fails closed independently so a
  // transient v_override_rate error doesn't blank the docs list and vice
  // versa.
  const [topResult, docsResult] = await Promise.allSettled([
    getTopEditRateCategories(3, MIN_SAMPLE_PER_CATEGORY),
    listKbDocuments({ limit: 200 }),
  ]);
  if (topResult.status === 'fulfilled') topCategories = topResult.value;
  else
    topErr = topResult.reason instanceof Error ? topResult.reason.message : 'metrics unavailable';
  if (docsResult.status === 'fulfilled') docs = docsResult.value;
  else docsErr = docsResult.reason instanceof Error ? docsResult.reason.message : 'kb unavailable';

  const totalDisposed = topCategories.reduce((acc, c) => acc + c.disposed, 0);
  const insufficientSignal = topCategories.length === 0 || totalDisposed < MIN_TOTAL_FOR_SIGNAL;

  return (
    <main className="flex min-h-screen flex-col bg-bg-deep text-ink">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle bg-bg-panel px-4">
        <div className="flex items-center gap-3">
          <h1 className="font-sans text-sm font-semibold tracking-tight">MailBox One</h1>
          <AppNav active="settings" />
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl p-4 lg:p-6">
        <section className="mb-6">
          <h2 className="mb-1 font-sans text-base font-semibold">
            Knowledge base — improve your drafts
          </h2>
          <p className="text-sm text-ink-muted">
            Drop SOPs, FAQs, or playbooks for the categories where your drafts get rewritten the
            most. Files stay on this appliance — they're embedded locally and only the matching
            snippet is ever shown to the LLM.
          </p>
        </section>

        {topErr && (
          <div className="mb-4 rounded border border-accent-orange/40 bg-accent-orange/10 p-3 text-xs text-accent-orange">
            Couldn't load drafting metrics — showing the catch-all upload only.{' '}
            <span className="font-mono">{topErr}</span>
          </div>
        )}

        {insufficientSignal ? (
          // ─── Empty state ──────────────────────────────────────────
          // Per the issue's acceptance criteria: when v_override_rate has
          // fewer than 5 drafts in any category (or fewer than 20 total),
          // suppress the targeted nudges entirely and tell the operator
          // to come back later. No false-precision suggestions.
          <section className="mb-6 rounded border border-border-subtle bg-bg-panel p-4">
            <h3 className="mb-2 font-sans text-sm font-semibold">Not enough drafts yet</h3>
            <p className="text-sm text-ink-muted">
              Come back after your first 20 drafts and we'll point you at the categories that need
              the most help. For now, you can upload any docs you want via the catch-all knowledge
              base.
            </p>
            <a
              href={apiUrl('/knowledge-base')}
              className="mt-3 inline-block rounded border border-border-subtle px-3 py-1 font-mono text-xs hover:bg-bg-deep"
            >
              Go to knowledge base →
            </a>
          </section>
        ) : (
          // ─── Targeted nudges ─────────────────────────────────────
          <section className="mb-6">
            <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Top {topCategories.length} categor{topCategories.length === 1 ? 'y' : 'ies'} by edit
              rate
            </h2>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {topCategories.map((c) => (
                <CategoryNudgeCard
                  key={c.classification_category}
                  category={c.classification_category}
                  edit_reject_rate={c.edit_reject_rate}
                  disposed={c.disposed}
                />
              ))}
            </div>
            <p className="mt-3 text-xs text-ink-dim">
              Source: <code className="font-mono">mailbox.v_override_rate</code> (last 14 days,
              minimum {MIN_SAMPLE_PER_CATEGORY} disposed drafts per category).
            </p>
          </section>
        )}

        <section className="mb-6">
          <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
            Existing documents
          </h2>
          {docsErr ? (
            <div className="rounded border border-accent-red/40 bg-accent-red/10 p-3 text-xs text-accent-red">
              <p className="mb-1 font-medium">Failed to load knowledge base</p>
              <p className="font-mono">{docsErr}</p>
            </div>
          ) : docs.length === 0 ? (
            <p className="rounded border border-border-subtle bg-bg-panel p-3 text-sm text-ink-muted">
              No documents uploaded yet. Drop a file on a category above or use the{' '}
              <a className="underline hover:text-ink" href={apiUrl('/knowledge-base')}>
                catch-all knowledge base
              </a>
              .
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle rounded border border-border-subtle bg-bg-panel">
              {docs.map((d) => (
                <li key={d.id} className="flex items-baseline justify-between p-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-sans text-sm">{d.title}</div>
                    <div className="font-mono text-[11px] text-ink-dim">
                      {d.filename} · {d.chunk_count} chunks
                    </div>
                  </div>
                  <span
                    className={`ml-3 font-mono text-[11px] ${
                      d.status === 'ready'
                        ? 'text-accent-green'
                        : d.status === 'failed'
                          ? 'text-accent-red'
                          : 'text-ink-dim'
                    }`}
                  >
                    {d.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-ink-dim">
            Need to delete or retry?{' '}
            <a className="underline hover:text-ink" href={apiUrl('/knowledge-base')}>
              Manage all documents →
            </a>
          </p>
        </section>
      </div>
    </main>
  );
}
