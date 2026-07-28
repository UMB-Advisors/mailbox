import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as autoLink from '@/lib/crm/auto-link';
import {
  AccountMutationError,
  accountHasData,
  createAccount,
  createImapAccount,
  createMicrosoftAccount,
  deleteAccount,
  getDefaultAccountId,
  listAccountsDetailed,
  setDefaultAccount,
  updateAccount,
} from '@/lib/queries-accounts';
import {
  closeTestPool,
  deleteSeededDraft,
  getTestPool,
  HAS_DB,
  type SeededDraft,
  seedDraft,
} from '../helpers/db';

// Plan 05-03 — persistAccountLink seam coverage wraps linkAccountToBusiness
// as a vi.fn() that calls through to the real implementation by default, so
// every test below except the ENT-05 case exercises the real DB-backed
// resolution rule. Only the ENT-05 case overrides it (mockRejectedValueOnce)
// to prove the non-fatal guarantee — the module cache is per-test-file, so
// this mock never leaks into other test files.
vi.mock('@/lib/crm/auto-link', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crm/auto-link')>();
  return {
    ...actual,
    linkAccountToBusiness: vi.fn(actual.linkAccountToBusiness),
  };
});

// MBOX-366 (MBOX-162 V5) — account registry CRUD. DB-backed: skips without
// TEST_POSTGRES_URL (same gate as the route suites). The shared Postgres runs
// serial (vitest fileParallelism:false), so this suite is meticulous about
// restoring the seeded default account + deleting every row it creates —
// other files assume exactly one default with mail flowing to it.

const dbDescribe = HAS_DB ? describe : describe.skip;

// Unique per run so reruns against a persistent DB never collide on the
// email_address UNIQUE constraint.
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const emailFor = (tag: string) => `v5-${tag}-${stamp}@example.test`;

dbDescribe('queries-accounts CRUD — real Postgres', () => {
  let originalDefaultId: number;
  const createdIds = new Set<number>();
  const seededDrafts: SeededDraft[] = [];

  beforeAll(async () => {
    originalDefaultId = await getDefaultAccountId();
  });

  afterEach(async () => {
    // Restore the seeded default so a set-default test never leaves the box
    // pointing at a temp account other files will then delete.
    const current = await getDefaultAccountId().catch(() => undefined);
    if (current !== originalDefaultId) {
      await setDefaultAccount(originalDefaultId);
    }
  });

  afterAll(async () => {
    for (const s of seededDrafts) await deleteSeededDraft(s);
    const pool = getTestPool();
    // Plan 05-03 — createAccount now auto-links a business as a side effect
    // (e.g. the 'Consulting' display_label below). Look up each created
    // account's business_id before deleting the account (the FK is ON
    // DELETE SET NULL from accounts, so deleting the account first would
    // silently orphan the business row forever) and delete it too — this
    // suite shares a database with the rest of the tree and must not leak
    // business rows.
    for (const id of createdIds) {
      const { rows } = await pool.query<{ business_id: number | null }>(
        'SELECT business_id FROM mailbox.accounts WHERE id = $1',
        [id],
      );
      const businessId = rows[0]?.business_id ?? null;
      await pool.query('DELETE FROM mailbox.accounts WHERE id = $1', [id]);
      if (businessId !== null) {
        await pool.query('DELETE FROM mailbox.businesses WHERE id = $1', [businessId]);
      }
    }
    await closeTestPool();
  });

  it('creates a non-default account with provider + created_at', async () => {
    const acct = await createAccount({
      email_address: emailFor('create'),
      display_label: 'Consulting',
      provider: 'gmail',
    });
    createdIds.add(acct.id);

    expect(acct.is_default).toBe(false);
    expect(acct.provider).toBe('gmail');
    expect(acct.display_label).toBe('Consulting');
    expect(typeof acct.created_at).toBe('string');

    const all = await listAccountsDetailed();
    expect(all.some((a) => a.id === acct.id)).toBe(true);
    // Default-first ordering.
    expect(all[0].is_default).toBe(true);
  });

  it('rejects a duplicate email_address with AccountMutationError', async () => {
    const email = emailFor('dup');
    const first = await createAccount({
      email_address: email,
      display_label: null,
      provider: 'gmail',
    });
    createdIds.add(first.id);

    await expect(
      createAccount({ email_address: email, display_label: null, provider: 'gmail' }),
    ).rejects.toMatchObject({ name: 'AccountMutationError', code: 'duplicate_email' });
  });

  it('updates the label in place, leaving email immutable', async () => {
    const acct = await createAccount({
      email_address: emailFor('rename'),
      display_label: 'Before',
      provider: 'gmail',
    });
    createdIds.add(acct.id);

    const updated = await updateAccount(acct.id, { display_label: 'After' });
    expect(updated?.display_label).toBe('After');
    expect(updated?.email_address).toBe(acct.email_address);

    // Clearing the label → null.
    const cleared = await updateAccount(acct.id, { display_label: null });
    expect(cleared?.display_label).toBeNull();
  });

  it('updateAccount returns null for a missing id', async () => {
    expect(await updateAccount(2_000_000_000, { display_label: 'x' })).toBeNull();
  });

  it('set-default swaps the default and keeps exactly one', async () => {
    const acct = await createAccount({
      email_address: emailFor('default'),
      display_label: 'Founder',
      provider: 'gmail',
    });
    createdIds.add(acct.id);

    const promoted = await setDefaultAccount(acct.id);
    expect(promoted.is_default).toBe(true);

    const all = await listAccountsDetailed();
    const defaults = all.filter((a) => a.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(acct.id);
    // afterEach restores originalDefaultId.
  });

  it('set-default throws not_found for a missing id', async () => {
    await expect(setDefaultAccount(2_000_000_001)).rejects.toMatchObject({
      name: 'AccountMutationError',
      code: 'not_found',
    });
  });

  it('refuses to delete the default inbox', async () => {
    await expect(deleteAccount(originalDefaultId)).rejects.toMatchObject({
      name: 'AccountMutationError',
      code: 'cannot_delete_default',
    });
  });

  it('refuses to delete an account that has mail/draft history', async () => {
    const acct = await createAccount({
      email_address: emailFor('hasdata'),
      display_label: null,
      provider: 'gmail',
    });
    createdIds.add(acct.id);

    const seeded = await seedDraft({ accountId: acct.id });
    seededDrafts.push(seeded);

    expect(await accountHasData(acct.id)).toBe(true);
    await expect(deleteAccount(acct.id)).rejects.toMatchObject({
      name: 'AccountMutationError',
      code: 'account_has_data',
    });
  });

  it('deletes a clean non-default account; missing id returns false', async () => {
    const acct = await createAccount({
      email_address: emailFor('clean'),
      display_label: null,
      provider: 'gmail',
    });

    expect(await accountHasData(acct.id)).toBe(false);
    expect(await deleteAccount(acct.id)).toBe(true);
    // Already gone → false (not an error).
    expect(await deleteAccount(acct.id)).toBe(false);
  });
});

// Plan 05-03 — persistAccountLink seam: all three account creators
// (createAccount, createImapAccount, createMicrosoftAccount) funnel through
// one internal auto-link call site positioned after their insert-or-adopt
// branch resolves (D-02/D-03). Coverage lives here, not in
// connect-imap.test.ts / connect-graph.test.ts, which fully mock this module
// and are structurally incapable of catching a broken auto-link.
dbDescribe('auto-link business (persistAccountLink seam)', () => {
  let originalDefaultId: number;
  let originalDefaultRow: {
    email_address: string;
    display_label: string | null;
    provider: string;
    provider_config: unknown;
    provider_secret_enc: string | null;
    business_id: number | null;
  };
  const createdAccountIds = new Set<number>();
  const createdBusinessIds = new Set<number>();

  beforeAll(async () => {
    originalDefaultId = await getDefaultAccountId();
    const pool = getTestPool();
    const { rows } = await pool.query(
      `SELECT email_address, display_label, provider, provider_config, provider_secret_enc, business_id
         FROM mailbox.accounts WHERE id = $1`,
      [originalDefaultId],
    );
    originalDefaultRow = rows[0];

    // On a fresh appliance (and on this throwaway-fixture-bootstrapped test
    // DB) the seeded default account's email IS the migration-033 sentinel
    // (primary@appliance.local) — the real unclaimed state. Move it off the
    // sentinel up front so every "insert branch" case below is order-
    // independent: it hits the insert branch regardless of whether the
    // dedicated ADOPT case (which re-arms the sentinel for its own single
    // call, see below) has run yet in this file. Restored to the true
    // original value once, in afterAll.
    await pool.query('UPDATE mailbox.accounts SET email_address = $2 WHERE id = $1', [
      originalDefaultId,
      `${stamp}-original-default-placeholder@example.test`,
    ]);
  });

  afterEach(async () => {
    // Same discipline as the CRUD suite above: restore the seeded default id
    // if a test changed it. Row *content* (email/label/etc.) is restored
    // once in afterAll, not per-test — several tests in this block
    // deliberately leave the default row in a non-sentinel, non-original
    // state on purpose (see beforeAll's comment) and a per-test restore back
    // to the true original would re-arm the sentinel mid-block and break
    // the order-independence the placeholder swap exists to guarantee.
    const current = await getDefaultAccountId().catch(() => undefined);
    if (current !== originalDefaultId) {
      await setDefaultAccount(originalDefaultId);
    }
  });

  afterAll(async () => {
    const pool = getTestPool();
    await pool.query(
      `UPDATE mailbox.accounts
          SET email_address = $2, display_label = $3, provider = $4,
              provider_config = $5::jsonb, provider_secret_enc = $6, business_id = $7
        WHERE id = $1`,
      [
        originalDefaultId,
        originalDefaultRow.email_address,
        originalDefaultRow.display_label,
        originalDefaultRow.provider,
        JSON.stringify(originalDefaultRow.provider_config ?? {}),
        originalDefaultRow.provider_secret_enc,
        originalDefaultRow.business_id,
      ],
    );
    for (const id of createdAccountIds) {
      await pool.query('DELETE FROM mailbox.accounts WHERE id = $1', [id]);
    }
    for (const id of createdBusinessIds) {
      await pool.query('DELETE FROM mailbox.businesses WHERE id = $1', [id]);
    }
  });

  async function getBusinessId(accountId: number): Promise<number | null> {
    const pool = getTestPool();
    const { rows } = await pool.query<{ business_id: number | null }>(
      'SELECT business_id FROM mailbox.accounts WHERE id = $1',
      [accountId],
    );
    return rows[0]?.business_id ?? null;
  }

  async function getBusinessName(businessId: number): Promise<string> {
    const pool = getTestPool();
    const { rows } = await pool.query<{ name: string }>(
      'SELECT name FROM mailbox.businesses WHERE id = $1',
      [businessId],
    );
    return rows[0].name;
  }

  it('createAccount links a new business named after display_label (ENT-01)', async () => {
    const label = `AutoLink Co ${stamp}`;
    const acct = await createAccount({
      email_address: emailFor('autolink-create'),
      display_label: label,
      provider: 'gmail',
    });
    createdAccountIds.add(acct.id);

    const businessId = await getBusinessId(acct.id);
    expect(businessId).not.toBeNull();
    createdBusinessIds.add(businessId as number);
    expect(await getBusinessName(businessId as number)).toBe(label);
  });

  it('createImapAccount insert branch links a business (D-04)', async () => {
    const label = `IMAP Insert Co ${stamp}`;
    const { id, adopted } = await createImapAccount({
      email: emailFor('imap-insert'),
      display_label: label,
      provider_config: { host: 'imap.example.test' },
      secret_enc: 'enc-placeholder',
    });

    expect(adopted).toBe(false);
    // Defensive: never queue the shared default row for deletion in afterAll
    // even if a future regression makes this take the adopt branch instead.
    if (id !== originalDefaultId) createdAccountIds.add(id);

    const businessId = await getBusinessId(id);
    expect(businessId).not.toBeNull();
    createdBusinessIds.add(businessId as number);
  });

  it('createImapAccount sentinel-ADOPT branch links a business too (D-03)', async () => {
    const pool = getTestPool();
    // Recreate the unclaimed-sentinel state on the current default row.
    await pool.query('UPDATE mailbox.accounts SET email_address = $1 WHERE id = $2', [
      'primary@appliance.local',
      originalDefaultId,
    ]);

    const label = `Adopt Co ${stamp}`;
    const { id, adopted } = await createImapAccount({
      email: emailFor('imap-adopt'),
      display_label: label,
      provider_config: { host: 'imap.example.test' },
      secret_enc: 'enc-placeholder',
    });

    expect(adopted).toBe(true);
    expect(id).toBe(originalDefaultId);
    // Deliberately NOT added to createdAccountIds — this is the shared
    // default row, restored (not deleted) in afterAll.
    const businessId = await getBusinessId(id);
    expect(businessId).not.toBeNull();
    createdBusinessIds.add(businessId as number);
  });

  it('createMicrosoftAccount insert branch links a business (D-04 provider parity)', async () => {
    const label = `Graph Insert Co ${stamp}`;
    const { id, adopted } = await createMicrosoftAccount({
      email: emailFor('graph-insert'),
      display_label: label,
      provider_config: { tenant_id: 't', client_id: 'c', mailbox: 'm' },
      secret_enc: 'enc-placeholder',
    });

    expect(adopted).toBe(false);
    if (id !== originalDefaultId) createdAccountIds.add(id);

    const businessId = await getBusinessId(id);
    expect(businessId).not.toBeNull();
    createdBusinessIds.add(businessId as number);
  });

  it('a second account on an already-linked non-free-mail domain attaches to the same business (ENT-03, D-16)', async () => {
    const domain = `siblingco-${stamp}.test`;
    const first = await createAccount({
      email_address: `first@${domain}`,
      display_label: `Sibling Co ${stamp}`,
      provider: 'gmail',
    });
    createdAccountIds.add(first.id);
    const firstBusinessId = await getBusinessId(first.id);
    expect(firstBusinessId).not.toBeNull();
    createdBusinessIds.add(firstBusinessId as number);

    const second = await createAccount({
      email_address: `second@${domain}`,
      display_label: 'A Totally Different Label',
      provider: 'gmail',
    });
    createdAccountIds.add(second.id);
    const secondBusinessId = await getBusinessId(second.id);

    expect(secondBusinessId).toBe(firstBusinessId);
  });

  it('two free-mail accounts with different labels end up on two different businesses (D-07)', async () => {
    const first = await createAccount({
      email_address: `personal-a-${stamp}@gmail.com`,
      display_label: `Personal A ${stamp}`,
      provider: 'gmail',
    });
    createdAccountIds.add(first.id);
    const firstBusinessId = await getBusinessId(first.id);
    expect(firstBusinessId).not.toBeNull();
    createdBusinessIds.add(firstBusinessId as number);

    const second = await createAccount({
      email_address: `personal-b-${stamp}@gmail.com`,
      display_label: `Personal B ${stamp}`,
      provider: 'gmail',
    });
    createdAccountIds.add(second.id);
    const secondBusinessId = await getBusinessId(second.id);
    expect(secondBusinessId).not.toBeNull();
    expect(secondBusinessId).not.toBe(firstBusinessId);
    createdBusinessIds.add(secondBusinessId as number);
  });

  it('an account resolving to an existing business name reuses it rather than creating a duplicate (ENT-02)', async () => {
    const label = `Reuse Co ${stamp}`;
    // Both sides use free-mail domains (never the shared example.test domain
    // emailFor() uses, which by this point in the block already has other
    // tests' accounts linked to it) so the sibling-domain lookup (D-16) is
    // structurally skipped on both accounts — this test is purely about the
    // find-or-create-by-name path (ENT-02), not sibling-domain attach.
    const first = await createAccount({
      email_address: `reuse-first-${stamp}@gmail.com`,
      display_label: label,
      provider: 'gmail',
    });
    createdAccountIds.add(first.id);
    const firstBusinessId = await getBusinessId(first.id);
    expect(firstBusinessId).not.toBeNull();
    createdBusinessIds.add(firstBusinessId as number);

    const second = await createAccount({
      email_address: `reuse-second-${stamp}@yahoo.com`,
      display_label: label,
      provider: 'gmail',
    });
    createdAccountIds.add(second.id);
    const secondBusinessId = await getBusinessId(second.id);

    expect(secondBusinessId).toBe(firstBusinessId);
  });

  it('a rejecting linkAccountToBusiness leaves the account connected with business_id null (ENT-05, D-05)', async () => {
    // mockRejectedValueOnce queues a single one-shot override on top of the
    // vi.fn(actual.linkAccountToBusiness) default set up in the vi.mock
    // factory above — it self-restores to the real implementation for every
    // subsequent call/test, no manual reset needed.
    const mockedLink = autoLink.linkAccountToBusiness as unknown as ReturnType<typeof vi.fn>;
    mockedLink.mockRejectedValueOnce(new Error('forced auto-link failure'));

    const acct = await createAccount({
      email_address: emailFor('forced-fail'),
      display_label: `Forced Fail Co ${stamp}`,
      provider: 'gmail',
    });
    createdAccountIds.add(acct.id);
    expect(await getBusinessId(acct.id)).toBeNull();
  });
});

// Guard so the suite isn't silently empty in environments without a DB.
describe('queries-accounts CRUD — guard', () => {
  it(HAS_DB ? 'runs against Postgres' : 'skips without TEST_POSTGRES_URL', () => {
    expect(typeof AccountMutationError).toBe('function');
  });
});
