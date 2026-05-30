import { getPersona } from '@/lib/queries-persona';
import { DEFAULT_STYLE_PROFILE, hasLiteralToneOverride, markersToStyle } from '@/lib/tuning/style';
import { TuningSettings } from './TuningSettings';

export const dynamic = 'force-dynamic';

// MBOX-162 P5a (sandbox UI port §P5) — Tuning surface. Server-loads the persona
// row, resolves the Style subset out of statistical_markers, and hands the form
// the initial values. The Style tab is a friendly editor over the same markers
// the legacy /settings/persona JSON editor exposes; saving merges (never
// clobbers) so the two surfaces coexist.
//
// P5b adds the Guidelines/Rules tab here. P5c (raw-prompt editor) is deferred.

export default async function TuningSettingsPage() {
  let initialStyle = { ...DEFAULT_STYLE_PROFILE };
  let toneOverride = false;
  let loadError: string | null = null;

  try {
    const persona = await getPersona();
    const markers = persona?.statistical_markers ?? {};
    initialStyle = markersToStyle(markers);
    toneOverride = hasLiteralToneOverride(markers);
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Failed to load tuning settings';
  }

  return (
    <TuningSettings initialStyle={initialStyle} toneOverride={toneOverride} loadError={loadError} />
  );
}
