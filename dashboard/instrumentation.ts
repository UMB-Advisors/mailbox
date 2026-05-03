// dashboard/instrumentation.ts
//
// Next.js 14 instrumentation hook. Runs ONCE on cold boot of the Node
// runtime (not the Edge runtime, not during `next build`). We use it to
// schedule the in-process classify sweeper that auto-recovers from a
// MailBOX-Classify outage. See lib/jobs/classify-sweeper.ts for the why.
//
// Requires `experimental.instrumentationHook: true` in next.config.js.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { startClassifySweeper } = await import('./lib/jobs/classify-sweeper');
  startClassifySweeper();
}
