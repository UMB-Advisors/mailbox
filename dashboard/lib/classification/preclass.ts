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
//   OPERATOR_DOMAINS   = comma-separated domains (default: heronlabsinc.com)
//   OPERATOR_ALLOWLIST = comma-separated full addresses (default: empty)

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

export interface PreclassContext {
  from?: string;
  to?: string;
}

export interface PreclassResult {
  category: Category;
  confidence: number;
  source: 'operator-domain' | 'operator-allowlist';
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

  if (OPERATOR_ALLOWLIST.includes(fromAddr)) {
    return { category: 'internal', confidence: 1, source: 'operator-allowlist' };
  }

  const domain = extractDomain(fromAddr);
  if (domain && OPERATOR_DOMAINS.includes(domain)) {
    return { category: 'internal', confidence: 1, source: 'operator-domain' };
  }

  return null;
}
