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
// This module holds both halves: the pure resolution primitives
// (name/domain/slug logic, no I/O) and the database-backed layer (sibling
// lookup, idempotent find-or-create, and the linkAccountToBusiness entry
// point).

import { getKysely, getPool } from '@/lib/db';

// The migration-033 seeded sentinel row. An unclaimed sentinel is not a real
// mailbox and must never produce a business named after the appliance host.
const SENTINEL_EMAIL = 'primary@appliance.local';

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

// D-13 — start from generateSlug(name), then probe for an existing row and
// append an incrementing numeric suffix until the candidate is free. Capped
// at 100 attempts; past that we throw rather than loop forever — the caller
// boundary (linkAccountToBusiness) is non-fatal, so an escaped throw here
// degrades to "unlinked account," never a hung request. Safe at this table's
// row count (single digits today); the unique index from plan 05-01 is the
// real guarantee, this loop just avoids surfacing a raw 23505 to the caller.
export async function generateUniqueSlug(name: string): Promise<string> {
  const base = generateSlug(name);
  let candidate = base;
  let suffix = 2;
  const MAX_ATTEMPTS = 100;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { rows } = await getPool().query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM mailbox.businesses WHERE slug = $1) AS exists',
      [candidate],
    );
    if (!rows[0]?.exists) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  throw new Error(`generateUniqueSlug: exceeded ${MAX_ATTEMPTS} attempts for base "${base}"`);
}

// D-16's exact lookup and the literal implementation of ENT-03: "is another
// account on this same domain already linked to a business? then join it."
// Parses the domain inside SQL with split_part rather than fetching rows and
// filtering in JS, matching this repo's established convention (see
// lib/queries-sender-allowlist.ts's BARE_ADDR_SQL). No self-exclusion clause
// is needed: the calling account's business_id is null at this point by
// construction (both the runtime hook and the backfill only ever process
// unlinked accounts), so IS NOT NULL already excludes it.
export async function findBusinessIdBySiblingDomain(domain: string): Promise<number | null> {
  const { rows } = await getPool().query<{ business_id: number }>(
    `SELECT business_id FROM mailbox.accounts
      WHERE split_part(email_address, '@', 2) = $1
        AND business_id IS NOT NULL
      ORDER BY id LIMIT 1`,
    [domain],
  );
  return rows[0]?.business_id ?? null;
}

export interface FindOrCreateBusinessResult {
  id: number;
  created: boolean;
}

// D-08's locked shape: INSERT ... ON CONFLICT (name) DO NOTHING RETURNING id,
// then a fallback SELECT when zero rows return. businesses.name is already
// globally UNIQUE (migration 053), so this is idempotent by construction.
// Zero rows from the fallback SELECT is unreachable (a conflict implies the
// row exists) but we throw a descriptive error there anyway rather than
// return a bogus id — the caller boundary (linkAccountToBusiness) swallows
// it. Every value is passed positionally — never interpolated into the SQL
// string.
export async function findOrCreateBusiness(name: string): Promise<FindOrCreateBusinessResult> {
  const slug = await generateUniqueSlug(name);
  const ins = await getPool().query<{ id: number }>(
    `INSERT INTO mailbox.businesses (name, slug)
     VALUES ($1, $2)
     ON CONFLICT (name) DO NOTHING
     RETURNING id`,
    [name, slug],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, created: true };

  const sel = await getPool().query<{ id: number }>(
    'SELECT id FROM mailbox.businesses WHERE name = $1',
    [name],
  );
  if (!sel.rows[0]) {
    throw new Error(
      `findOrCreateBusiness: INSERT conflicted on name "${name}" but no matching row was found`,
    );
  }
  return { id: sel.rows[0].id, created: false };
}

export interface LinkAccountToBusinessInput {
  accountId: number;
  email: string;
  displayLabel: string | null;
}

// The single entry point. Implements D-16's fixed resolution order exactly:
//   1. Sentinel address → no-op (an unclaimed sentinel row is not a real
//      mailbox; the runtime hook can't receive it since the adopt branch
//      rewrites the address before linking, but the backfill script iterates
//      raw rows and can).
//   2. Non-free-mail domain → try the sibling-account domain lookup first. A
//      hit ends resolution — attach to that business, skip find-or-create.
//   3. Otherwise (free-mail domain, or no linked sibling) → resolve the name
//      via resolveBusinessName and find-or-create by it.
//   4. Persist via Kysely (accounts is in kysely-codegen's scope, so a stale
//      lib/db/schema.ts turns into a compile error here instead of silent
//      schema drift).
//
// The whole body is wrapped in one try/catch that logs and returns rather
// than rethrowing (D-05/ENT-05) — a failure here must degrade to "unlinked
// account," never to "connect failed."
export async function linkAccountToBusiness(input: LinkAccountToBusinessInput): Promise<void> {
  try {
    const { accountId, email, displayLabel } = input;
    if (email === SENTINEL_EMAIL) return;

    const domain = extractEmailDomain(email);

    let businessId: number | null = null;
    if (!isFreeMailDomain(domain)) {
      businessId = await findBusinessIdBySiblingDomain(domain);
    }

    if (businessId === null) {
      const name = resolveBusinessName(email, displayLabel);
      const result = await findOrCreateBusiness(name);
      businessId = result.id;
    }

    await getKysely()
      .updateTable('accounts')
      .set({ business_id: businessId })
      .where('id', '=', accountId)
      .execute();
  } catch (err) {
    console.error('[auto-link] linkAccountToBusiness failed (non-fatal):', err);
  }
}
