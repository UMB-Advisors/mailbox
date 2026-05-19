// STAQPRO-404 deliverable #6 — stub (filled in Task 4).
// Renders nothing useful yet — the App wiring lands first so we can typecheck.
export function DigestPreview({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-zinc-50">
      <p className="text-sm text-zinc-500">Digest preview — stub (Task 4 fills this in).</p>
      <button
        type="button"
        onClick={onBack}
        className="rounded-full bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-700"
      >
        Back
      </button>
    </div>
  )
}
