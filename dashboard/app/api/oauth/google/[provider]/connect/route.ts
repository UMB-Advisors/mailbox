import { randomBytes } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { parseParams } from '@/lib/middleware/validate';
import { buildConsentUrl } from '@/lib/oauth/google';
import { oauthProviderParamSchema } from '@/lib/schemas/oauth';

// MBOX-130 + MBOX-129 — connect-flow initiator. The settings page's "Connect
// Google Calendar / Tasks" button navigates here; we 302 the operator to
// Google's consent screen with an HMAC-signed state param pinning the provider.
// The callback (/api/oauth/google/callback) verifies the state, exchanges the
// code for a refresh token, and stores it AES-256-GCM-encrypted.
//
// GET /api/oauth/google/[provider]/connect → 302 to Google consent

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: { provider: string } },
): Promise<NextResponse> {
  const p = parseParams(params, oauthProviderParamSchema);
  if (!p.ok) return p.response;

  try {
    // Nonce binds this redirect to its callback. State is HMAC-signed so a
    // forged callback can't smuggle a provider; verifyState rejects a bad MAC.
    const nonce = randomBytes(16).toString('base64url');
    const url = buildConsentUrl(p.data.provider, nonce);
    return NextResponse.redirect(url);
  } catch (error) {
    console.error(`GET /api/oauth/google/${params.provider}/connect failed:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
