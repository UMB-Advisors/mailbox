// D-50 — deterministic operator-identity preclass.
//
// The Qwen3 classifier has no inherent knowledge of which sender domains
// belong to the operator, which collapses internal-recall to ~0.22 in
// scoring (see 02-04b SUMMARY). Resolve at the boundary: if the sender's
// domain matches the operator domain (or address allowlist), force the
// classification to `internal` regardless of what the LLM said.
//
// v1 scope: from-address domain match only. `to` is plumbed through for
// future use (multi-mailbox / contractor allowlist on shared domains)
// but not consulted yet.
//
// Configuration via env (defaults baked in for the live operator):
//   OPERATOR_DOMAINS         = comma-separated domains (default: heronlabsinc.com)
//   OPERATOR_ALLOWLIST       = comma-separated full addresses (default: empty)
//   OPERATOR_INBOX_EXCEPTIONS = comma-separated addresses that should NOT trigger
//                              the override even though they sit on the operator
//                              domain — e.g. role inboxes (sales@, support@) that
//                              receive prospect mail through aliases. Default seeds
//                              sales@heronlabsinc.com because the 02-04b post-D50
//                              scoring caught a real prospect inquiry sent through
//                              that address being misrouted to local.

import type { Category } from './prompt';

function splitEnv(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const OPERATOR_DOMAINS: ReadonlyArray<string> = splitEnv(
  process.env.OPERATOR_DOMAINS,
  'heronlabsinc.com',
);

export const OPERATOR_ALLOWLIST: ReadonlyArray<string> = splitEnv(
  process.env.OPERATOR_ALLOWLIST,
  '',
);

export const OPERATOR_INBOX_EXCEPTIONS: ReadonlyArray<string> = splitEnv(
  process.env.OPERATOR_INBOX_EXCEPTIONS,
  'sales@heronlabsinc.com',
);

export interface PreclassContext {
  from?: string;
  to?: string;
}

export interface PreclassResult {
  category: Category;
  confidence: number;
  source: 'operator-domain' | 'operator-allowlist' | 'noreply-pattern';
}

// STAQPRO-260 — deterministic noreply preclass.
//
// Many automated senders (notifications@github.com, noreply@stripe.com,
// mailer-daemon@*, etc.) generate emails that the LLM classifier
// occasionally routes to internal/unknown/inquiry, which produces useless
// drafts in the operator queue. Catch them at the boundary by sender
// pattern and force `spam_marketing` — `routeFor` already drops that.
//
// Patterns match a noreply token bounded by delimiters (`-`, `_`, `.`, `+`)
// anywhere within the local-part, with the token adjacent to `@` on at least
// one side. This catches both prefix forms (`noreply@`, `notifications@`) and
// the suffix forms that the original anchored-at-start version missed
// (`drive-shares-dm-noreply@google.com`, `alerts+notifications@`). The
// trailing `@` anchor in `LOCAL_PART_TOKEN_RE` is what prevents matching
// domains like `eric@notifications-co.com` — token must end the local-part.
//
// Configuration:
//   NOREPLY_PATTERNS         = comma-separated extra regexes appended to defaults
//                              (case-insensitive, evaluated after the bake-ins)
//   NOREPLY_PRECLASS_DISABLE = '1' to short-circuit the entire check
const NOREPLY_TOKENS = [
  'no-?reply',
  'do-?not-?reply',
  'donotreply',
  'noreply',
  'notifications?',
  'mailer-daemon',
  'postmaster',
  'bounces?',
  'auto-?reply',
  'auto-?confirm',
] as const;

// (^|[-_.+]) <token> ([-_.+])? @  — token must end the local-part (immediately
// before `@`, with at most one trailing delimiter), and must be preceded by
// the start of the local-part or a delimiter. Prevents `noreplyguy@` (no
// preceding delimiter / no trailing `@`) and `eric@notifications-co.com`
// (token in domain, not local-part).
const LOCAL_PART_TOKEN_RE = new RegExp(
  `(?:^|[-_.+])(?:${NOREPLY_TOKENS.join('|')})(?:[-_.+])?@`,
  'i',
);

const NOREPLY_DEFAULTS: ReadonlyArray<RegExp> = [
  LOCAL_PART_TOKEN_RE,
  // Domain explicitly carries a noreply/notifications subdomain
  /@(noreply|notifications?)\./i,
  /\.noreply\./i,
  // Common product-noreply domain prefixes (e.g. `bounce.example.com`,
  // `mailer.example.com`) where the local-part varies but the sending
  // identity is uniformly automated.
  /@(?:bounce|bounces|mailer|email)\.[^.]+\./i,
];

function compileExtraPatterns(raw: string | undefined): ReadonlyArray<RegExp> {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((src) => {
      try {
        return new RegExp(src, 'i');
      } catch {
        // Bad regex in env shouldn't crash the classifier — skip and log.
        console.warn(`[preclass] invalid NOREPLY_PATTERNS entry skipped: ${src}`);
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
}

const NOREPLY_EXTRA: ReadonlyArray<RegExp> = compileExtraPatterns(process.env.NOREPLY_PATTERNS);

export const NOREPLY_PATTERNS: ReadonlyArray<RegExp> = [...NOREPLY_DEFAULTS, ...NOREPLY_EXTRA];

function noreplyPreclassEnabled(): boolean {
  return process.env.NOREPLY_PRECLASS_DISABLE !== '1';
}

function extractAddress(raw: string | undefined): string {
  if (!raw) return '';
  const angle = raw.match(/<([^>]+)>/);
  const addr = (angle ? angle[1] : raw).trim().toLowerCase();
  return addr;
}

function extractDomain(addr: string): string {
  const at = addr.lastIndexOf('@');
  return at >= 0 ? addr.slice(at + 1) : '';
}

export function precheck(ctx: PreclassContext): PreclassResult | null {
  const fromAddr = extractAddress(ctx.from);
  if (!fromAddr) return null;

  // Allowlist always wins — explicit named addresses are intentional.
  if (OPERATOR_ALLOWLIST.includes(fromAddr)) {
    return { category: 'internal', confidence: 1, source: 'operator-allowlist' };
  }

  // Role-inbox exceptions short-circuit the domain rule. These addresses
  // sit on the operator domain but legitimately receive prospect mail.
  if (OPERATOR_INBOX_EXCEPTIONS.includes(fromAddr)) {
    return null;
  }

  const domain = extractDomain(fromAddr);
  if (domain && OPERATOR_DOMAINS.includes(domain)) {
    return { category: 'internal', confidence: 1, source: 'operator-domain' };
  }

  return null;
}

// STAQPRO-260 — drop emails from automated senders before they reach the
// LLM classifier. Returns `null` when no pattern matches OR when the
// kill-switch env is set OR when the sender is on the operator allowlist
// (allowlist beats noreply, in case an operator legitimately uses a
// noreply-shaped address — unlikely but cheap insurance).
export function precheckNoReply(ctx: PreclassContext): PreclassResult | null {
  if (!noreplyPreclassEnabled()) return null;

  const fromAddr = extractAddress(ctx.from);
  if (!fromAddr) return null;

  if (OPERATOR_ALLOWLIST.includes(fromAddr)) return null;

  if (NOREPLY_PATTERNS.some((re) => re.test(fromAddr))) {
    return { category: 'spam_marketing', confidence: 1, source: 'noreply-pattern' };
  }

  return null;
}
