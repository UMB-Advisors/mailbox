import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  getJobInstance,
  listJobInstances,
  setJobInstanceEnabled,
  upsertJobInstance,
} from '@/lib/queries-job-instances';
import { closeTestPool, getTestPool, HAS_DB } from '../helpers/db';

// MBOX-462 P0 — job_instances CRUD against a real Postgres (the fixture-loaded
// CI pg, or a tunnel locally). Skips without TEST_POSTGRES_URL like the other
// DB suites. The shared DB runs serial; afterEach deletes only this suite's row.

const dbDescribe = HAS_DB ? describe : describe.skip;
const TID = 'daily-digest';

dbDescribe('queries-job-instances CRUD — real Postgres', () => {
  afterEach(async () => {
    await getTestPool().query('DELETE FROM mailbox.job_instances WHERE template_id = $1', [TID]);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('upsert creates the instance with enabled flag, params and schedule', async () => {
    const inst = await upsertJobInstance({
      template_id: TID,
      enabled: true,
      params: { send_hour_local: 7 },
      schedule: '0 7 * * *',
    });
    expect(inst.template_id).toBe(TID);
    expect(inst.enabled).toBe(true);
    expect(inst.params).toEqual({ send_hour_local: 7 });
    expect(inst.schedule).toBe('0 7 * * *');
    expect(inst.model).toBeNull();
  });

  it('upsert is idempotent on template_id and a re-enable does not clobber params', async () => {
    await upsertJobInstance({ template_id: TID, enabled: true, params: { send_hour_local: 9 } });
    const again = await upsertJobInstance({ template_id: TID, enabled: false });
    expect(again.enabled).toBe(false);
    expect(again.params).toEqual({ send_hour_local: 9 }); // preserved, not reset to {}
    const mine = (await listJobInstances()).filter((i) => i.template_id === TID);
    expect(mine).toHaveLength(1); // UNIQUE(template_id) held — no second row
  });

  it('getJobInstance returns null before enable and the row after', async () => {
    expect(await getJobInstance(TID)).toBeNull();
    await upsertJobInstance({ template_id: TID, enabled: true });
    expect((await getJobInstance(TID))?.enabled).toBe(true);
  });

  it('setJobInstanceEnabled flips the flag, and returns null when absent', async () => {
    expect(await setJobInstanceEnabled(TID, true)).toBeNull(); // no row yet
    await upsertJobInstance({ template_id: TID, enabled: true });
    const off = await setJobInstanceEnabled(TID, false);
    expect(off?.enabled).toBe(false);
  });
});
