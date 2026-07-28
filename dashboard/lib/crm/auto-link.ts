// M5 Phase 5 — the single shared account→business resolution rule.
//
// WHAT: turns a connected mailbox account into a linked CRM business.
//
// WHY: ENT-01 (auto-create named from display_label else domain), ENT-02
// (idempotent), ENT-03 via D-16 (sibling-account domain attach instead of a
// businesses.domain column that doesn't exist), ENT-05/D-05 (silent,
// non-fatal — a failure here must never break account connection), and
// FILT-05/D-13 (frozen unique slug generated once at creation).
//
// Binding decision pointers: D-06 (naming order), D-07 (free-mail exclusion
// list), D-08 (idempotent find-or-create shape), D-13 (slug generation +
// collision suffixing), D-16 (fixed resolution order — sentinel skip,
// free-mail gate, sibling-domain attach, then find-or-create by name).
//
// This half holds the pure resolution primitives (name/domain/slug logic, no
// I/O). The database-backed half (sibling lookup, idempotent find-or-create,
// and the linkAccountToBusiness entry point) lives in the same module.

// D-07 — public consumer mail hosts. Domain matching (the sibling-account
// lookup, D-16) skips these entirely: two accounts sharing gmail.com are not
// the same business. This is a fixed universal set, not env-configurable —
// unlike lib/classification/preclass.ts's OPERATOR_DOMAINS (a different axis:
// this appliance's own per-install company domain). One exported constant so
// Phase 6/7 can reuse it.
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'msn.com',
]);

// Mirrors lib/classification/preclass.ts:extractDomain's logic (substring
// after the last '@', lowercased) rather than importing it — lib/crm
// importing from lib/classification would be a wrong dependency direction
// between two unrelated domains.
export function extractEmailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.toLowerCase());
}

// D-06 — name resolution order: a non-blank trimmed displayLabel wins,
// otherwise the email domain. Deliberately contains no reference to
// FREE_MAIL_DOMAINS (Pitfall 3): the free-mail rule gates only the
// sibling-domain match, never naming. Two free-mail accounts with different
// display labels must still resolve to different names.
export function resolveBusinessName(email: string, displayLabel: string | null): string {
  const trimmed = displayLabel?.trim();
  if (trimmed) return trimmed;
  return extractEmailDomain(email);
}

// D-13 — lowercase kebab of the name, ASCII-folded (diacritics stripped via
// NFD decomposition), non-alphanumerics collapsed to a single hyphen, trimmed
// of leading/trailing hyphens. An all-symbol name (or a name that folds to
// nothing) falls back to the literal 'business' so this can never violate
// the businesses.slug NOT NULL constraint. Collision suffixing (-2, -3, ...)
// needs a database round-trip and is NOT part of this function — see
// generateUniqueSlug, which keeps this one pure and unit-testable, and is
// what makes the SQL-parity gate against migration 057's backfill expression
// possible.
export function generateSlug(name: string): string {
  const folded = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics (U+0300–U+036F)
    .toLowerCase();
  const kebab = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return kebab || 'business';
}
