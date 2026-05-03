'use client';

import type { ReactNode } from 'react';
import { stepForSlug, type WizardStepSlug } from '@/lib/onboarding/wizard-stages';
import { StageIndicator } from './StageIndicator';
import { StepNav } from './StepNav';

interface StepShellProps {
  slug: WizardStepSlug;
  children: ReactNode;
}

// Card wrapper for every wizard step. Title + intent come from
// WIZARD_STEPS so per-page bodies stay short and the doc-template content
// stays in lockstep with the wizard.
export function StepShell({ slug, children }: StepShellProps) {
  const step = stepForSlug(slug);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <StageIndicator currentSlug={slug} />
      <article className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6 shadow-lg sm:p-8">
        <header className="mb-4">
          <h1 className="text-xl font-semibold text-neutral-100 sm:text-2xl">{step.title}</h1>
          <p className="mt-2 text-sm text-neutral-400">{step.intent}</p>
        </header>
        <div className="text-sm text-neutral-300">{children}</div>
        <StepNav slug={slug} />
      </article>
    </div>
  );
}
