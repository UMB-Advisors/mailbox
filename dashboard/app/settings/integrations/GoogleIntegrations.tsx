'use client';

import { Calendar, CheckSquare, Link2, Unlink } from 'lucide-react';
import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { TimeAgo } from '@/components/TimeAgo';
import { Toast } from '@/components/Toast';
import { apiUrl } from '@/lib/api';
import type { OAuthConnection, OAuthProvider } from '@/lib/oauth/google';

// MBOX-130 + MBOX-129 — Google integrations connect/disconnect UI. One card per
// provider: Calendar (read-only pre-read, MBOX-130) and Tasks (action-item
// handoff, MBOX-129). Connect navigates to the connect-initiate route (302 to
// Google consent); disconnect revokes + clears the stored token. Matches the
// VIP settings style (App Shell + bg-panel cards + Tailwind v4 @theme tokens).

type ToastMsg = { kind: 'success' | 'error'; text: string } | null;

const META: Record<
  Extract<OAuthProvider, 'google_calendar' | 'google_tasks'>,
  { title: string; blurb: string; Icon: typeof Calendar }
> = {
  google_calendar: {
    title: 'Google Calendar',
    blurb:
      'Read-only. Scheduling drafts pre-read your calendar so the box can propose concrete open times instead of "let me check my calendar."',
    Icon: Calendar,
  },
  google_tasks: {
    title: 'Google Tasks',
    blurb:
      'Push extracted action items to your Google Tasks list with one click from the draft detail view.',
    Icon: CheckSquare,
  },
};

function fallback(provider: OAuthProvider): OAuthConnection {
  return {
    provider,
    connected: false,
    scope: null,
    account_email: null,
    last_fetched_at: null,
    connected_at: null,
  };
}

export function GoogleIntegrations({
  calendar,
  tasks,
  loadError,
}: {
  calendar: OAuthConnection | null;
  tasks: OAuthConnection | null;
  loadError: string | null;
}) {
  const [conns, setConns] = useState<Record<string, OAuthConnection>>({
    google_calendar: calendar ?? fallback('google_calendar'),
    google_tasks: tasks ?? fallback('google_tasks'),
  });
  const [busy, setBusy] = useState<OAuthProvider | null>(null);
  const [toast, setToast] = useState<ToastMsg>(null);

  function connect(provider: OAuthProvider) {
    // Full-page navigation to the connect initiator, which 302s to Google.
    window.location.href = apiUrl(`/api/oauth/google/${provider}/connect`);
  }

  async function disconnect(provider: OAuthProvider) {
    setBusy(provider);
    try {
      const res = await fetch(apiUrl(`/api/oauth/google/${provider}`), { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Disconnect failed (${res.status})`);
      setConns((prev) => ({ ...prev, [provider]: fallback(provider) }));
      setToast({ kind: 'success', text: `Disconnected ${META[provider as keyof typeof META].title}` });
    } catch (err) {
      setToast({ kind: 'error', text: err instanceof Error ? err.message : 'Disconnect failed' });
    } finally {
      setBusy(null);
    }
  }

  const providers: Array<keyof typeof META> = ['google_calendar', 'google_tasks'];

  return (
    <AppShell active={{ kind: 'surface', surface: 'settings' }}>
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
        <header>
          <h1 className="font-mono text-lg uppercase tracking-wider text-ink">Integrations</h1>
          <p className="mt-1 font-sans text-sm text-ink-dim">
            Connect your Google account so the box can read your calendar and push tasks. Each
            integration uses its own scope and token — connecting one does not grant the other.
          </p>
        </header>

        {loadError && (
          <p className="font-sans text-sm text-accent-red">
            Couldn’t load integration status: <span className="font-mono">{loadError}</span>
          </p>
        )}

        {providers.map((provider) => {
          const conn = conns[provider];
          const { title, blurb, Icon } = META[provider];
          return (
            <section
              key={provider}
              className="rounded-sm border border-border bg-bg-panel p-4"
            >
              <div className="flex items-start gap-3">
                <Icon size={18} className="mt-0.5 shrink-0 text-ink-dim" aria-hidden />
                <div className="min-w-0 flex-1">
                  <h2 className="font-mono text-sm uppercase tracking-wide text-ink">{title}</h2>
                  <p className="mt-1 font-sans text-sm text-ink-dim">{blurb}</p>

                  {conn.connected ? (
                    <dl className="mt-3 flex flex-col gap-1 font-mono text-xs text-ink-muted">
                      <div className="flex gap-2">
                        <dt className="text-ink-dim">Account</dt>
                        <dd className="text-ink">{conn.account_email ?? '(unknown)'}</dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="text-ink-dim">Last fetched</dt>
                        <dd className="text-ink">
                          <TimeAgo iso={conn.last_fetched_at} />
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="mt-3 font-mono text-xs uppercase tracking-wide text-ink-dim">
                      Not connected
                    </p>
                  )}
                </div>

                <div className="shrink-0">
                  {conn.connected ? (
                    <button
                      type="button"
                      onClick={() => disconnect(provider)}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 rounded-sm border border-accent-red/40 px-2 py-1 font-sans text-xs text-accent-red transition-colors hover:bg-accent-red/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Unlink size={13} /> {busy === provider ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => connect(provider)}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 rounded-sm border border-accent-blue/40 px-2 py-1 font-sans text-xs text-accent-blue transition-colors hover:bg-accent-blue/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Link2 size={13} /> Connect
                    </button>
                  )}
                </div>
              </div>
            </section>
          );
        })}
      </div>

      {toast && <Toast kind={toast.kind} text={toast.text} onDismiss={() => setToast(null)} />}
    </AppShell>
  );
}
