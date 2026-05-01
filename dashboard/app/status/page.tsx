import {
  type Alert,
  COST_SPIKE_MIN_TRIGGER_USD,
  DRAFT_BACKLOG_THRESHOLD_HOURS,
  evaluateAlerts,
} from '@/lib/alerts';
import {
  getActiveWorkflowCount,
  getCloudSpend24h,
  getCloudSpendLastHour,
  getDiskFree,
  getDraftBacklogAged,
  getDraftCounts24h,
  getLastEmailReceivedAt,
  getLastError,
  getLastInferenceLatency,
  getN8nFailures24h,
  getOllamaLoadedModels,
  getQueueDepth,
} from '@/lib/queries-system';

export const dynamic = 'force-dynamic';

// STAQPRO-146 / FR-29 — operator-facing system status page.
// Server-rendered each request; auto-refreshes via meta refresh every 30s.

export default async function StatusPage() {
  const [
    queueDepth,
    lastError,
    lastInference,
    lastEmailReceivedAt,
    activeWorkflowCount,
    diskFree,
    ollamaModels,
    draftCounts24h,
    cloudSpend24h,
    draftBacklogAged,
    n8nFailures24h,
    cloudSpendLastHour,
  ] = await Promise.all([
    getQueueDepth().catch(() => null),
    getLastError().catch(() => ({ message: null, at: null })),
    getLastInferenceLatency().catch(() => ({ latency_ms: null, at: null })),
    getLastEmailReceivedAt().catch(() => null),
    getActiveWorkflowCount(),
    getDiskFree('/'),
    getOllamaLoadedModels(),
    getDraftCounts24h().catch(() => null),
    getCloudSpend24h().catch(() => null),
    getDraftBacklogAged(DRAFT_BACKLOG_THRESHOLD_HOURS).catch(() => null),
    getN8nFailures24h(),
    getCloudSpendLastHour(),
  ]);

  const alerts = evaluateAlerts({
    draftBacklog: draftBacklogAged,
    n8nFailures: n8nFailures24h,
    cloudCostSpike:
      cloudSpendLastHour !== null && cloudSpend24h !== null
        ? {
            last_hour_usd: cloudSpendLastHour,
            trailing_24h_usd: cloudSpend24h.total_usd,
            min_trigger_usd: COST_SPIKE_MIN_TRIGGER_USD,
          }
        : null,
  });

  const uptimeSeconds = Math.round(process.uptime());

  return (
    <>
      {/* Auto-refresh every 30s. Server-rendered; no client component needed. */}
      <meta httpEquiv="refresh" content="30" />
      <main className="mx-auto min-h-screen max-w-7xl p-4 lg:p-6">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="font-sans text-xl font-semibold tracking-tight">
              MailBox One — System Status
            </h1>
            <p className="mt-0.5 text-xs text-ink-dim">
              Auto-refreshes every 30s. Last rendered {new Date().toISOString()}.
            </p>
          </div>
          <nav className="flex items-center gap-3 text-sm">
            <a className="text-ink-muted hover:text-ink" href="/queue">
              ← Queue
            </a>
          </nav>
        </header>

        {alerts.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Alerts
            </h2>
            <ul className="space-y-2">
              {alerts.map((a) => (
                <AlertBanner key={a.code} alert={a} />
              ))}
            </ul>
          </section>
        )}

        <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Uptime" value={formatUptime(uptimeSeconds)} mono />
          <Stat
            label="Queue depth"
            value={queueDepth ?? '—'}
            tone={queueDepth !== null && queueDepth > 20 ? 'orange' : 'default'}
            sub="pending + awaiting_cloud"
          />
          <Stat
            label="n8n active workflows"
            value={activeWorkflowCount ?? '—'}
            sub="MailBOX + MailBOX-Send expected = 2"
            tone={activeWorkflowCount !== null && activeWorkflowCount < 2 ? 'red' : 'default'}
          />
          <Stat
            label="Last email"
            value={formatRelative(lastEmailReceivedAt)}
            sub={lastEmailReceivedAt ?? 'no emails yet'}
            mono
          />
        </section>

        <section className="mb-6">
          <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
            Drafts (last 24h)
          </h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Total" value={draftCounts24h?.total ?? '—'} />
            <Stat label="Sent" value={draftCounts24h?.sent ?? '—'} tone="green" />
            <Stat label="Pending" value={draftCounts24h?.pending ?? '—'} tone="orange" />
            <Stat
              label="Failed"
              value={draftCounts24h?.failed ?? '—'}
              tone={draftCounts24h && draftCounts24h.failed > 0 ? 'red' : 'default'}
            />
            <Stat label="Rejected" value={draftCounts24h?.rejected ?? '—'} />
          </div>
        </section>

        <section className="mb-6">
          <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
            Cloud spend (last 24h)
          </h2>
          <Card>
            {cloudSpend24h === null ? (
              <p className="text-sm text-ink-dim">unavailable</p>
            ) : (
              <>
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-2xl font-semibold tracking-tight">
                    ${cloudSpend24h.total_usd.toFixed(4)}
                  </span>
                  <span className="text-sm text-ink-muted">
                    over {cloudSpend24h.call_count} cloud-route call
                    {cloudSpend24h.call_count === 1 ? '' : 's'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-dim">
                  Source-of-truth: <code className="font-mono">mailbox.drafts.cost_usd</code> summed
                  where <code className="font-mono">draft_source</code> went via cloud (Ollama Cloud
                  primary, Anthropic alt). Local Qwen3 calls excluded — they cost $0 on-device.
                </p>
                {Object.keys(cloudSpend24h.by_source).length > 0 && (
                  <ul className="mt-3 space-y-1 text-xs">
                    {Object.entries(cloudSpend24h.by_source).map(([source, stats]) => (
                      <li key={source} className="flex justify-between font-mono">
                        <span className="text-ink-muted">{source}</span>
                        <span>
                          ${stats.total_usd.toFixed(4)} ({stats.call_count})
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Card>
        </section>

        <section className="mb-6 grid gap-3 lg:grid-cols-2">
          <Card title="Last inference">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-2xl font-semibold tracking-tight">
                {lastInference.latency_ms !== null ? `${lastInference.latency_ms}ms` : '—'}
              </span>
              {lastInference.at && (
                <span className="text-xs text-ink-dim">{formatRelative(lastInference.at)}</span>
              )}
            </div>
            <p className="mt-1 text-xs text-ink-dim">
              SLA: &lt;30s local / &lt;60s cloud per project Constraints
            </p>
          </Card>
          <Card title="Disk">
            {diskFree ? (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-2xl font-semibold tracking-tight">
                    {formatBytes(diskFree.free_bytes)}
                  </span>
                  <span className="text-sm text-ink-muted">
                    free of {formatBytes(diskFree.total_bytes)}
                  </span>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded bg-bg-deep">
                  <div
                    className="h-full bg-accent-blue"
                    style={{
                      width: `${Math.round(
                        ((diskFree.total_bytes - diskFree.free_bytes) / diskFree.total_bytes) * 100,
                      )}%`,
                    }}
                  />
                </div>
              </>
            ) : (
              <span className="text-ink-dim">unavailable</span>
            )}
          </Card>
        </section>

        <section className="mb-6">
          <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
            Ollama loaded models
          </h2>
          <Card>
            {ollamaModels === null ? (
              <p className="text-sm text-accent-red">
                Ollama unreachable at{' '}
                <code className="font-mono">
                  {process.env.OLLAMA_BASE_URL ?? 'http://ollama:11434'}
                </code>{' '}
                — local drafting path is degraded; cloud route still works.
              </p>
            ) : ollamaModels.length === 0 ? (
              <p className="text-sm text-ink-dim">
                No models in memory. First request will load on demand.
              </p>
            ) : (
              <ul className="space-y-1 text-sm">
                {ollamaModels.map((m) => (
                  <li key={m.name} className="flex items-center justify-between">
                    <span className="font-mono">{m.name}</span>
                    {m.size_vram !== undefined && (
                      <span className="text-xs text-ink-dim">{formatBytes(m.size_vram)} VRAM</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        {lastError.message && (
          <section className="mb-6">
            <h2 className="mb-3 font-sans text-sm font-semibold uppercase tracking-wider text-ink-muted">
              Last error
            </h2>
            <div className="rounded border border-accent-red/40 bg-accent-red/10 p-4">
              <p className="mb-1 text-xs text-ink-muted">
                {formatRelative(lastError.at)} · most recent draft with{' '}
                <code className="font-mono">error_message</code>
              </p>
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-accent-red">
                {lastError.message}
              </pre>
            </div>
          </section>
        )}

        <footer className="mt-12 text-center text-xs text-ink-dim">
          STAQPRO-146 / FR-29 ·{' '}
          <a className="hover:text-ink-muted" href="/api/system/status">
            JSON
          </a>
        </footer>
      </main>
    </>
  );
}

interface StatProps {
  label: string;
  value: string | number;
  sub?: string;
  mono?: boolean;
  tone?: 'default' | 'green' | 'red' | 'orange';
}

function Stat({ label, value, sub, mono, tone = 'default' }: StatProps) {
  const toneClass =
    tone === 'green'
      ? 'text-accent-green'
      : tone === 'red'
        ? 'text-accent-red'
        : tone === 'orange'
          ? 'text-accent-orange'
          : 'text-ink';
  return (
    <div className="rounded border border-border-subtle bg-bg-panel p-3">
      <div className="text-xs uppercase tracking-wider text-ink-dim">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold tracking-tight ${toneClass} ${mono ? 'font-mono' : 'font-sans'}`}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-ink-dim">{sub}</div>}
    </div>
  );
}

function AlertBanner({ alert }: { alert: Alert }) {
  const toneClass =
    alert.severity === 'alarm'
      ? 'border-accent-red/40 bg-accent-red/10 text-accent-red'
      : 'border-accent-orange/40 bg-accent-orange/10 text-accent-orange';
  return (
    <li className={`rounded border p-3 ${toneClass}`}>
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-xs uppercase tracking-wider">{alert.severity}</span>
        <span className="font-mono text-xs text-ink-dim">{alert.code}</span>
      </div>
      <p className="mt-1 text-sm">{alert.message}</p>
    </li>
  );
}

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-border-subtle bg-bg-panel p-4">
      {title && <div className="mb-2 text-xs uppercase tracking-wider text-ink-dim">{title}</div>}
      {children}
    </div>
  );
}

// ── Formatters ─────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ${m % 60}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let n = bytes;
  do {
    n /= 1024;
    i += 1;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const seconds = Math.round((Date.now() - t) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
