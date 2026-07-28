import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  extractEmailDomain,
  FREE_MAIL_DOMAINS,
  findBusinessIdBySiblingDomain,
  findOrCreateBusiness,
  generateSlug,
  generateUniqueSlug,
  isFreeMailDomain,
  linkAccountToBusiness,
  resolveBusinessName,
} from '@/lib/crm/auto-link';
import { createBusiness, updateBusiness } from '@/lib/crm/queries';
import { getKysely, getPool } from '@/lib/db';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

// M5 Phase 5 Plan 2 — the single shared account→business resolution rule
// (D-16). This block is pure-function only — no I/O, must run on every CI
// machine with no TEST_POSTGRES_URL set.

describe('auto-link — pure functions (no DB)', () => {
  describe('generateSlug', () => {
    it.each([
      ['Altitude Guitar', 'altitude-guitar'],
      ['UMB Advisors', 'umb-advisors'],
      ['AutoCSR', 'autocsr'],
      ['Jiffy Auto Glass', 'jiffy-auto-glass'],
      ['Elevated Advisory', 'elevated-advisory'],
      ['Bonvillian Design', 'bonvillian-design'],
      ['  Café  Ünïcode  ', 'cafe-unicode'],
      ['!!!', 'business'],
    ])('generateSlug(%j) -> %j', (input, expected) => {
      expect(generateSlug(input)).toBe(expected);
    });

    it('is idempotent for every live business name plus the edge cases', () => {
      const names = [
        'Altitude Guitar',
        'UMB Advisors',
        'AutoCSR',
        'Jiffy Auto Glass',
        'Elevated Advisory',
        'Bonvillian Design',
        '  Café  Ünïcode  ',
        '!!!',
      ];
      for (const name of names) {
        const once = generateSlug(name);
        const twice = generateSlug(once);
        expect(twice).toBe(once);
      }
    });
  });

  describe('extractEmailDomain', () => {
    it('lowercases and extracts the domain', () => {
      expect(extractEmailDomain('mike@Altitudeguitar.com')).toBe('altitudeguitar.com');
    });

    it('returns empty string when there is no @', () => {
      expect(extractEmailDomain('not-an-email')).toBe('');
    });
  });

  describe('isFreeMailDomain', () => {
    it('matches case-insensitively', () => {
      expect(isFreeMailDomain('GMAIL.com')).toBe(true);
    });

    it('returns false for a non-free-mail domain', () => {
      expect(isFreeMailDomain('umbadvisors.com')).toBe(false);
    });

    it('contains exactly the twelve D-07 hosts', () => {
      expect([...FREE_MAIL_DOMAINS].sort()).toEqual(
        [
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
        ].sort(),
      );
    });
  });

  describe('resolveBusinessName', () => {
    it('prefers a non-blank display label (D-06)', () => {
      expect(resolveBusinessName('mike@autocsr.com', 'AutoCSR')).toBe('AutoCSR');
    });

    it('falls back to the email domain when no label', () => {
      expect(resolveBusinessName('mike@autocsr.com', null)).toBe('autocsr.com');
    });

    it('treats a whitespace-only label as no label', () => {
      expect(resolveBusinessName('mike@autocsr.com', '   ')).toBe('autocsr.com');
    });

    it('resolves names identically for free-mail domains (Pitfall 3)', () => {
      expect(resolveBusinessName('mike@gmail.com', 'Mike Personal')).toBe('Mike Personal');
    });
  });

  describe('linkAccountToBusiness — non-fatal on internal failure (ENT-05, D-05)', () => {
    it('resolves normally when the underlying database call throws', async () => {
      vi.spyOn(getPool(), 'query').mockImplementationOnce(() => {
        throw new Error('simulated database failure');
      });
      await expect(
        linkAccountToBusiness({
          accountId: 999999,
          email: 'nonfatal-test@umbadvisors.com',
          displayLabel: null,
        }),
      ).resolves.toBeUndefined();
      vi.restoreAllMocks();
    });
  });
});

// ── DB-gated block — real Postgres required ─────────────────────────────

const dbDescribe = HAS_DB ? describe : describe.skip;

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const nameFor = (tag: string) => `AutoLink Test ${tag} ${stamp}`;
const emailFor = (tag: string) => `autolink-${tag}-${stamp}@example.test`;

dbDescribe('auto-link — real Postgres', () => {
  const businessIds: number[] = [];
  const accountIds: number[] = [];

  async function makeAccount(email: string, displayLabel: string | null): Promise<number> {
    const row = await getKysely()
      .insertInto('accounts')
      .values({
        email_address: email,
        display_label: displayLabel,
        is_default: false,
        provider: 'gmail',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    accountIds.push(row.id);
    return row.id;
  }

  afterAll(async () => {
    const pool = getTestPool();
    for (const id of accountIds) {
      await pool.query('DELETE FROM mailbox.accounts WHERE id = $1', [id]);
    }
    for (const id of businessIds) {
      await pool.query('DELETE FROM mailbox.businesses WHERE id = $1', [id]);
    }
    await closeTestPool();
  });

  it('findOrCreateBusiness is idempotent (ENT-02)', async () => {
    const name = nameFor('idempotent');
    const first = await findOrCreateBusiness(name);
    businessIds.push(first.id);
    const second = await findOrCreateBusiness(name);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it('findOrCreateBusiness populates a slug derived from the name', async () => {
    const name = nameFor('slugged');
    const { id } = await findOrCreateBusiness(name);
    businessIds.push(id);

    const pool = getTestPool();
    const { rows } = await pool.query<{ slug: string }>(
      'SELECT slug FROM mailbox.businesses WHERE id = $1',
      [id],
    );
    expect(rows[0].slug).toBeTruthy();
    expect(rows[0].slug).toContain('autolink-test-slugged');
  });

  it('generateUniqueSlug returns the bare base slug when nothing collides', async () => {
    const name = nameFor('unique-direct');
    const slug = await generateUniqueSlug(name);
    expect(slug).toBe(generateSlug(name));
  });

  it('collision-suffixes the slug on a repeat base (-2, then -3)', async () => {
    // Two distinct names (businesses.name is UNIQUE) whose generateSlug
    // output is byte-identical once punctuation collapses — the real
    // collision path a name-based unique constraint can't prevent.
    const base = `Collision Base ${stamp}`;
    const nameA = `${base}!!!`;
    const nameB = `${base}???`;
    const nameC = `${base}...`;
    const baseSlug = generateSlug(nameA);
    expect(generateSlug(nameB)).toBe(baseSlug);
    expect(generateSlug(nameC)).toBe(baseSlug);

    const first = await findOrCreateBusiness(nameA);
    businessIds.push(first.id);
    const second = await findOrCreateBusiness(nameB);
    businessIds.push(second.id);
    const third = await findOrCreateBusiness(nameC);
    businessIds.push(third.id);

    const pool = getTestPool();
    const { rows } = await pool.query<{ id: number; slug: string }>(
      'SELECT id, slug FROM mailbox.businesses WHERE id = ANY($1) ORDER BY id',
      [[first.id, second.id, third.id]],
    );
    expect(rows.map((r) => r.slug)).toEqual([baseSlug, `${baseSlug}-2`, `${baseSlug}-3`]);
  });

  it('findOrCreateBusiness is parameterized against SQL injection', async () => {
    const maliciousName = `Robert'); DROP TABLE mailbox.businesses;--${stamp}`;
    const { id } = await findOrCreateBusiness(maliciousName);
    businessIds.push(id);

    const pool = getTestPool();
    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM mailbox.businesses WHERE id = $1',
      [id],
    );
    expect(rows[0].name).toBe(maliciousName);

    const survives = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM mailbox.businesses',
    );
    expect(Number(survives.rows[0].count)).toBeGreaterThan(0);
  });

  it('findBusinessIdBySiblingDomain returns the lowest-id linked sibling, or null', async () => {
    const domain = `sibling-${stamp}.test`;
    const noHit = await findBusinessIdBySiblingDomain(domain);
    expect(noHit).toBeNull();

    const biz = await findOrCreateBusiness(nameFor('sibling-business'));
    businessIds.push(biz.id);

    const acctId = await makeAccount(`first@${domain}`, null);
    await getKysely()
      .updateTable('accounts')
      .set({ business_id: biz.id })
      .where('id', '=', acctId)
      .execute();

    const hit = await findBusinessIdBySiblingDomain(domain);
    expect(hit).toBe(biz.id);
  });

  it('linkAccountToBusiness attaches to a sibling business without creating a new one (ENT-03, D-16)', async () => {
    const domain = `siblink-${stamp}.test`;
    const biz = await findOrCreateBusiness(nameFor('siblink-business'));
    businessIds.push(biz.id);

    const firstAcct = await makeAccount(`one@${domain}`, null);
    await getKysely()
      .updateTable('accounts')
      .set({ business_id: biz.id })
      .where('id', '=', firstAcct)
      .execute();

    const secondAcct = await makeAccount(`two@${domain}`, 'Some Other Label');
    await linkAccountToBusiness({
      accountId: secondAcct,
      email: `two@${domain}`,
      displayLabel: 'Some Other Label',
    });

    const row = await getKysely()
      .selectFrom('accounts')
      .select('business_id')
      .where('id', '=', secondAcct)
      .executeTakeFirstOrThrow();
    expect(row.business_id).toBe(biz.id);
  });

  it('linkAccountToBusiness creates (or finds) a business by resolved name when no sibling exists (ENT-01)', async () => {
    const email = emailFor('nosibling');
    const label = nameFor('nosibling-label');
    const acctId = await makeAccount(email, label);

    await linkAccountToBusiness({ accountId: acctId, email, displayLabel: label });

    const row = await getKysely()
      .selectFrom('accounts')
      .select('business_id')
      .where('id', '=', acctId)
      .executeTakeFirstOrThrow();
    expect(row.business_id).not.toBeNull();
    if (row.business_id) businessIds.push(row.business_id);

    const bizRow = await getKysely()
      .selectFrom('businesses')
      .select('name')
      .where('id', '=', row.business_id as number)
      .executeTakeFirstOrThrow();
    expect(bizRow.name).toBe(label);
  });

  it('two free-mail accounts with different labels end up on two different businesses (D-07, Pitfall 3)', async () => {
    const domain = 'gmail.com';
    const labelA = nameFor('freemail-a');
    const labelB = nameFor('freemail-b');
    const emailA = `freemail-a-${stamp}@${domain}`;
    const emailB = `freemail-b-${stamp}@${domain}`;

    const acctA = await makeAccount(emailA, labelA);
    await linkAccountToBusiness({ accountId: acctA, email: emailA, displayLabel: labelA });
    const acctB = await makeAccount(emailB, labelB);
    await linkAccountToBusiness({ accountId: acctB, email: emailB, displayLabel: labelB });

    const rowA = await getKysely()
      .selectFrom('accounts')
      .select('business_id')
      .where('id', '=', acctA)
      .executeTakeFirstOrThrow();
    const rowB = await getKysely()
      .selectFrom('accounts')
      .select('business_id')
      .where('id', '=', acctB)
      .executeTakeFirstOrThrow();

    expect(rowA.business_id).not.toBeNull();
    expect(rowB.business_id).not.toBeNull();
    expect(rowA.business_id).not.toBe(rowB.business_id);
    if (rowA.business_id) businessIds.push(rowA.business_id);
    if (rowB.business_id) businessIds.push(rowB.business_id);
  });

  it('a linked first free-mail account still does not domain-match a second (D-07)', async () => {
    const domain = 'yahoo.com';
    const labelFirst = nameFor('freemail-first');
    const labelSecond = nameFor('freemail-second');
    const emailFirst = `freemail-first-${stamp}@${domain}`;
    const emailSecond = `freemail-second-${stamp}@${domain}`;

    const acctFirst = await makeAccount(emailFirst, labelFirst);
    await linkAccountToBusiness({
      accountId: acctFirst,
      email: emailFirst,
      displayLabel: labelFirst,
    });

    const acctSecond = await makeAccount(emailSecond, labelSecond);
    await linkAccountToBusiness({
      accountId: acctSecond,
      email: emailSecond,
      displayLabel: labelSecond,
    });

    const rowFirst = await getKysely()
      .selectFrom('accounts')
      .select('business_id')
      .where('id', '=', acctFirst)
      .executeTakeFirstOrThrow();
    const rowSecond = await getKysely()
      .selectFrom('accounts')
      .select('business_id')
      .where('id', '=', acctSecond)
      .executeTakeFirstOrThrow();

    expect(rowFirst.business_id).not.toBe(rowSecond.business_id);
    if (rowFirst.business_id) businessIds.push(rowFirst.business_id);
    if (rowSecond.business_id) businessIds.push(rowSecond.business_id);
  });

  it('SQL/TS slug parity: generateSlug matches migration 057s backfill expression for all six live names', async () => {
    const liveNames = [
      'UMB Advisors',
      'AutoCSR',
      'Altitude Guitar',
      'Jiffy Auto Glass',
      'Elevated Advisory',
      'Bonvillian Design',
    ];
    const pool = getTestPool();
    for (const name of liveNames) {
      const { rows } = await pool.query<{ slug: string }>(
        `SELECT COALESCE(
             NULLIF(
               lower(regexp_replace(regexp_replace($1, '[^a-zA-Z0-9]+', '-', 'g'), '^-+|-+$', '', 'g')),
               ''
             ),
             'business'
           ) AS slug`,
        [name],
      );
      expect(generateSlug(name)).toBe(rows[0].slug);
    }
  });

  it('createBusiness returns a row with a non-empty unique slug', async () => {
    const name = nameFor('createBusiness');
    const biz = await createBusiness(name);
    businessIds.push(biz.id);
    expect(biz.slug).toBeTruthy();
  });

  it('updateBusiness rename leaves the slug unchanged (D-12)', async () => {
    const name = nameFor('rename-original');
    const biz = await createBusiness(name);
    businessIds.push(biz.id);
    const originalSlug = biz.slug;

    const renamed = await updateBusiness(biz.id, { name: nameFor('rename-updated') });
    expect(renamed?.slug).toBe(originalSlug);
  });
});
