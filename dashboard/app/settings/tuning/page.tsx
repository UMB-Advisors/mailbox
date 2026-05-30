import { getPersona } from '@/lib/queries-persona';
import { listPromptRules, type PromptRule } from '@/lib/queries-prompt-rules';
import { DEFAULT_STYLE_PROFILE, hasLiteralToneOverride, markersToStyle } from '@/lib/tuning/style';
import { TuningSettings } from './TuningSettings';

export const dynamic = 'force-dynamic';

// MBOX-162 P5a/P5b (sandbox UI port §P5) — Tuning surface. Server-loads the
// persona row (Style tab seed) and the operator's drafting guidelines
// (Guidelines tab seed) for the default account. The Style tab is a friendly
// editor over the same markers the legacy /settings/persona JSON editor
// exposes; saving merges (never clobbers) so the two surfaces coexist.
//
// P5c (raw-prompt editor) is deferred.

export default async function TuningSettingsPage() {
  let initialStyle = { ...DEFAULT_STYLE_PROFILE };
  let toneOverride = false;
  let initialRules: PromptRule[] = [];
  let loadError: string | null = null;

  try {
    const [persona, rules] = await Promise.all([getPersona(), listPromptRules()]);
    const markers = persona?.statistical_markers ?? {};
    initialStyle = markersToStyle(markers);
    toneOverride = hasLiteralToneOverride(markers);
    initialRules = rules;
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Failed to load tuning settings';
  }

  return (
    <TuningSettings
      initialStyle={initialStyle}
      initialRules={initialRules}
      toneOverride={toneOverride}
      loadError={loadError}
    />
  );
}
