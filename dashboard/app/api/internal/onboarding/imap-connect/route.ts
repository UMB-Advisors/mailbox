import { type NextRequest, NextResponse } from 'next/server';
import { testMailConnection } from '@/lib/mail/test-connection';
import { parseJson } from '@/lib/middleware/validate';
import { encryptToken } from '@/lib/oauth/google';
import { createImapAccount } from '@/lib/queries-accounts';
import { setEmail } from '@/lib/queries-onboarding';
import { imapConnectBodySchema } from '@/lib/schemas/imap-connect';

export const dynamic = 'force-dynamic';

// POST /api/internal/onboarding/imap-connect — MBOX-357 (P1 T6 / FR-MP-6).
//
// Called from the onboarding wizard's email-connect step (IMAP branch). Two
// modes share one route so the "Test connection" button and the "Connect &
// continue" save run the SAME validation:
//   mode:'test' → run the test-connection probe, return per-leg result, DON'T save.
//   mode:'save' → run the probe; ONLY on success persist the account + the
//                 AES-256-GCM-encrypted app-password and advance the wizard.
// The probe is dependency-light (raw TLS sockets, lib/mail/test-connection.ts).
// Bad credentials never reach the DB — a failed probe returns 422 and stops.
//
// Co-located with the sibling /api/internal/onboarding/advance route; like it,
// not Caddy-gated (onboarding precedes basic_auth setup). The app-password is
// never echoed back; only the boolean per-leg verdict + a safe detail string.
export async function POST(req: NextRequest) {
  const b = await parseJson(req, imapConnectBodySchema);
  if (!b.ok) return b.response;
  const d = b.data;
  const email = d.email.toLowerCase();

  const probe = await testMailConnection({
    imapHost: d.imap_host,
    imapPort: d.imap_port,
    smtpHost: d.smtp_host,
    smtpPort: d.smtp_port,
    username: d.username,
    password: d.app_password,
  });

  if (!probe.ok) {
    // Probe failed — never persist unvalidated credentials.
    return NextResponse.json({ ok: false, imap: probe.imap, smtp: probe.smtp }, { status: 422 });
  }

  if (d.mode === 'test') {
    return NextResponse.json({ ok: true, tested: true, imap: probe.imap, smtp: probe.smtp });
  }

  // mode === 'save' — probe passed; persist encrypted + advance the wizard.
  try {
    const providerConfig = {
      imap_host: d.imap_host,
      imap_port: d.imap_port,
      smtp_host: d.smtp_host,
      smtp_port: d.smtp_port,
      username: d.username,
      tls: true,
    };
    const { id, adopted } = await createImapAccount({
      email,
      display_label: d.display_label ?? null,
      provider_config: providerConfig,
      secret_enc: encryptToken(d.app_password),
    });
    // Record the connected mailbox on the onboarding row. setEmail also lands
    // stage at 'ingesting' — a no-op here since the email-connect step's DB
    // stage is already 'ingesting' (it mirrors the Gmail flow's intended call).
    await setEmail(email);
    return NextResponse.json({ ok: true, account_id: id, adopted });
  } catch (error) {
    console.error('POST /api/internal/onboarding/imap-connect (save) failed:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
