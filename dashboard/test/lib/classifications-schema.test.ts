import { describe, expect, it } from 'vitest';
import { reclassifyBySenderBodySchema } from '@/lib/schemas/classifications';

// MBOX-368 — pure validation tests for the reclassify-by-sender body schema.
// The email normalization (extractAddress) is the load-bearing bit: the value
// the schema produces must equal the lowercased bare address the classify-time
// preclass looks up, regardless of whether the operator/UI sent a bare address
// or a full "Name <addr>" header.
describe('reclassifyBySenderBodySchema', () => {
  it('extracts + lowercases a bare address', () => {
    const r = reclassifyBySenderBodySchema.safeParse({
      email: 'Joe@Acme.COM',
      category: 'inquiry',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe('joe@acme.com');
  });

  it('extracts the address out of a "Name <addr>" header', () => {
    const r = reclassifyBySenderBodySchema.safeParse({
      email: '"Joe Vendor" <Joe@Acme.com>',
      category: 'spam_marketing',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe('joe@acme.com');
  });

  it('rejects a value with no @ after extraction', () => {
    const r = reclassifyBySenderBodySchema.safeParse({
      email: 'not-an-email',
      category: 'inquiry',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a category outside CATEGORIES', () => {
    const r = reclassifyBySenderBodySchema.safeParse({
      email: 'a@b.com',
      category: 'totally_fake',
    });
    expect(r.success).toBe(false);
  });

  it('normalizes empty/whitespace reason to null and keeps a real note', () => {
    const blank = reclassifyBySenderBodySchema.safeParse({
      email: 'a@b.com',
      category: 'inquiry',
      reason: '   ',
    });
    expect(blank.success).toBe(true);
    if (blank.success) expect(blank.data.reason).toBeNull();

    const noted = reclassifyBySenderBodySchema.safeParse({
      email: 'a@b.com',
      category: 'inquiry',
      reason: 'vendor newsletter is actually a sales inquiry',
    });
    expect(noted.success).toBe(true);
    if (noted.success)
      expect(noted.data.reason).toBe('vendor newsletter is actually a sales inquiry');
  });
});
