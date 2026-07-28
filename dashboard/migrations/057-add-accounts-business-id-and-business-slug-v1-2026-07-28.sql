-- Migration 057 — M5 Unified Entities: account→business FK + frozen business slug.
-- WHAT: adds a nullable mailbox.accounts.business_id FK, adds mailbox.businesses.slug
--       (computed for existing rows, then constrained NOT NULL + UNIQUE), and seeds
--       the one legacy slug value that a live cron job still references.
-- WHY:  M5 / Phase 5 — MAP-01 (account↔business mapping) and FILT-05 (slug back-compat
--       so the agentbox3 cron job carrying the string `altitude` keeps resolving once
--       Phase 7 repoints the sidecar at the CRM). Per D-16 the runtime attach rule is
--       sibling-account-domain based; this migration adds only the storage, not the
--       rule.
-- ROLLBACK: DROP INDEX IF EXISTS mailbox.businesses_slug_key;
--           ALTER TABLE mailbox.businesses DROP COLUMN IF EXISTS slug;
--           ALTER TABLE mailbox.accounts DROP COLUMN IF EXISTS business_id;
--           then delete the row from mailbox.migrations.
-- BACKFILL: business_id is deliberately left NULL for every existing row — the
--       account→business linkage backfill runs as a separate idempotent Node script
--       (`npm run business:backfill`, plan 05-03) so it uses byte-identical resolution
--       logic to the runtime hook (D-10, "one rule, exercised twice"). Only `slug` is
--       backfilled here, by a deterministic SQL transform. Expected six live-data
--       name→slug pairs (parity record):
--         Altitude Guitar    → altitude-guitar (then overridden to `altitude`, D-14 seed)
--         UMB Advisors       → umb-advisors
--         AutoCSR            → autocsr
--         Jiffy Auto Glass   → jiffy-auto-glass
--         Elevated Advisory  → elevated-advisory
--         Bonvillian Design  → bonvillian-design
--       This SQL transform must stay byte-equivalent to
--       dashboard/lib/crm/auto-link.ts:generateSlug() (built in plan 05-02); a
--       DB-gated parity test in dashboard/test/lib/crm-auto-link.test.ts asserts the
--       two agree.

-- 1. accounts.business_id — nullable, never constrained (MAP-04 requires unmatched
--    accounts to stay unlinked; D-05 requires a failed auto-link to leave this null).
--    Mirrors migration 053's departments.business_id shape verbatim.
ALTER TABLE mailbox.accounts
  ADD COLUMN IF NOT EXISTS business_id INTEGER
  REFERENCES mailbox.businesses(id) ON DELETE SET NULL;

-- 2. businesses.slug — nullable at first, backfilled below, then constrained.
ALTER TABLE mailbox.businesses ADD COLUMN IF NOT EXISTS slug TEXT;

-- 3. Base backfill: lowercase kebab of the name, ASCII non-alphanumerics collapsed
--    to a single hyphen, trimmed; empty transform falls back to the literal 'business'.
UPDATE mailbox.businesses
   SET slug = COALESCE(
         NULLIF(
           lower(regexp_replace(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'), '^-+|-+$', '', 'g')),
           ''
         ),
         'business'
       )
 WHERE slug IS NULL;

-- 4. Collision suffixing (D-13): rows whose computed slug duplicates an earlier
--    row's get -2, -3, ... appended, in id order. Self-contained SQL — no Node/tsx
--    dependency at migration-apply time, since the migrate profile container has no
--    path to invoke a script mid-psql run.
DO $$
DECLARE
  r RECORD;
  candidate TEXT;
  n INTEGER;
BEGIN
  FOR r IN
    SELECT b.id, b.slug
      FROM mailbox.businesses b
     WHERE EXISTS (
             SELECT 1 FROM mailbox.businesses o
              WHERE o.slug = b.slug AND o.id < b.id
           )
     ORDER BY b.id
  LOOP
    n := 2;
    candidate := r.slug || '-' || n;
    WHILE EXISTS (SELECT 1 FROM mailbox.businesses WHERE slug = candidate) LOOP
      n := n + 1;
      candidate := r.slug || '-' || n;
    END LOOP;
    UPDATE mailbox.businesses SET slug = candidate WHERE id = r.id;
  END LOOP;
END $$;

-- 5. Legacy slug seed (FILT-05 / D-14) — exactly one row. This is the ONLY slug
--    seed; D-14 verified the live ~/.hermes/cron/jobs.json holds 4 jobs of which
--    exactly one carries a business slug. Guarded so it is idempotent and cannot
--    create a duplicate; placed before the constraints below so a defeated guard
--    fails the unique index creation loudly and rolls back the whole transaction
--    rather than shipping a duplicate.
UPDATE mailbox.businesses
   SET slug = 'altitude'
 WHERE name = 'Altitude Guitar'
   AND slug IS DISTINCT FROM 'altitude'
   AND NOT EXISTS (SELECT 1 FROM mailbox.businesses WHERE slug = 'altitude');

-- 6. Constrain: every business now has a slug; enforce it going forward.
ALTER TABLE mailbox.businesses ALTER COLUMN slug SET NOT NULL;

-- 7. Unique index (not ADD CONSTRAINT) so it supports IF NOT EXISTS and stays
--    re-runnable per D-11, matching the existing accounts_one_default index idiom.
CREATE UNIQUE INDEX IF NOT EXISTS businesses_slug_key ON mailbox.businesses (slug);
