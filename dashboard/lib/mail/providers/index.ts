// dashboard/lib/mail/providers/index.ts
//
// MBOX-356 (P0) — MailProvider factory. Resolves the transport implementation
// from accounts.provider. Callers branch on provider.capabilities.*, never on
// the provider name (DR-55). Closed set: an unknown provider is a programming
// error, not a runtime fallthrough.

import { GmailProvider } from './gmail';
import type { MailAccount, MailProvider, MailProviderKind } from './types';

export * from './types';
export { GmailProvider, NotImplementedInP0 } from './gmail';

// Singleton instances — providers are stateless (config comes in per call via
// MailAccount), so one instance per kind is sufficient.
const GMAIL = new GmailProvider();

export function providerFor(account: Pick<MailAccount, 'provider'>): MailProvider {
  return providerForKind(account.provider);
}

export function providerForKind(kind: MailProviderKind): MailProvider {
  switch (kind) {
    case 'gmail':
      return GMAIL;
    case 'imap':
      // P1 / MBOX-357.
      throw new Error(`MailProvider 'imap' not implemented yet (P1 / MBOX-357)`);
    case 'microsoft':
      // P2 / MBOX-358.
      throw new Error(`MailProvider 'microsoft' not implemented yet (P2 / MBOX-358)`);
    default: {
      // Exhaustiveness guard — if MailProviderKind grows, this stops compiling.
      const _exhaustive: never = kind;
      throw new Error(`Unknown MailProvider kind: ${String(_exhaustive)}`);
    }
  }
}
