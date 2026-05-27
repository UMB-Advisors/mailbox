// MBOX-184 — unit tests for the read-only "Update available" detector.
//
// Same convention as queries-orphans.test.ts / queries-docker.test.ts: inject
// the manifest JSON + a pre-resolved running-container list so the suite runs
// identically on macOS dev and the Jetson with no docker daemon and no repo
// bind mount.

import { describe, expect, it } from 'vitest';
import { checkUpdateAvailability, expectedContainerName, shortDigest } from '@/lib/queries-update';

const DASH_DIGEST_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DASH_DIGEST_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CADDY_DIGEST = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

function manifest(dashDigest: string, caddyDigest: string): string {
  return JSON.stringify({
    schema_version: 1,
    services: {
      'mailbox-dashboard': {
        repo: 'ghcr.io/umb-advisors/mailbox-dashboard',
        tag: 'abc1234',
        digest: dashDigest,
      },
      'mailbox-caddy': {
        repo: 'ghcr.io/umb-advisors/mailbox-caddy',
        tag: 'abc1234',
        digest: caddyDigest,
      },
    },
  });
}

describe('expectedContainerName — MBOX-184', () => {
  it('uses the explicit container_name override for mailbox-dashboard', () => {
    expect(expectedContainerName('mailbox-dashboard', 'mailbox')).toBe('mailbox-dashboard');
  });

  it('falls back to <project>-<service>-1 for caddy (no override)', () => {
    expect(expectedContainerName('mailbox-caddy', 'mailbox')).toBe('mailbox-caddy-1');
  });

  it('returns null for an unmapped manifest key', () => {
    expect(expectedContainerName('nope', 'mailbox')).toBeNull();
  });
});

describe('shortDigest', () => {
  it('shortens a sha256 digest to 7 hex chars', () => {
    expect(shortDigest(DASH_DIGEST_A)).toBe('aaaaaaa');
  });
  it('renders an em-dash for null', () => {
    expect(shortDigest(null)).toBe('—');
  });
  it('passes through a non-sha256 string unchanged', () => {
    expect(shortDigest('not-a-digest')).toBe('not-a-digest');
  });
});

describe('checkUpdateAvailability — comparison cases', () => {
  it('reports up_to_date when running digest matches the manifest', async () => {
    const r = await checkUpdateAvailability({
      manifestJson: manifest(DASH_DIGEST_A, CADDY_DIGEST),
      runningContainers: [
        {
          name: 'mailbox-dashboard',
          image: `ghcr.io/umb-advisors/mailbox-dashboard@${DASH_DIGEST_A}`,
          image_id: 'sha256:configdash',
        },
        {
          name: 'mailbox-caddy-1',
          image: `ghcr.io/umb-advisors/mailbox-caddy@${CADDY_DIGEST}`,
          image_id: 'sha256:configcaddy',
        },
      ],
    });
    expect(r.reason).toBeNull();
    expect(r.update_available).toBe(false);
    const dash = r.services.find((s) => s.service === 'mailbox-dashboard');
    expect(dash?.state).toBe('up_to_date');
  });

  it('reports update_available when the manifest digest differs from running', async () => {
    const r = await checkUpdateAvailability({
      manifestJson: manifest(DASH_DIGEST_B, CADDY_DIGEST),
      runningContainers: [
        {
          name: 'mailbox-dashboard',
          image: `ghcr.io/umb-advisors/mailbox-dashboard@${DASH_DIGEST_A}`,
          image_id: 'sha256:configdash',
        },
        {
          name: 'mailbox-caddy-1',
          image: `ghcr.io/umb-advisors/mailbox-caddy@${CADDY_DIGEST}`,
          image_id: 'sha256:configcaddy',
        },
      ],
    });
    expect(r.update_available).toBe(true);
    const dash = r.services.find((s) => s.service === 'mailbox-dashboard');
    expect(dash?.state).toBe('update_available');
    expect(dash?.running_digest).toBe(DASH_DIGEST_A);
    expect(dash?.manifest_digest).toBe(DASH_DIGEST_B);
    expect(dash?.detail).toContain('aaaaaaa');
    expect(dash?.detail).toContain('bbbbbbb');
  });

  it('reports local_build for a tag-only running image (M1 up -d --build path)', async () => {
    const r = await checkUpdateAvailability({
      manifestJson: manifest(DASH_DIGEST_A, CADDY_DIGEST),
      runningContainers: [
        {
          name: 'mailbox-dashboard',
          image: 'mailbox-mailbox-dashboard:latest',
          image_id: 'sha256:configdash',
        },
        {
          name: 'mailbox-caddy-1',
          image: 'mailbox-caddy:latest',
          image_id: 'sha256:configcaddy',
        },
      ],
    });
    // Local builds must NEVER produce a false "update available".
    expect(r.update_available).toBe(false);
    const dash = r.services.find((s) => s.service === 'mailbox-dashboard');
    expect(dash?.state).toBe('local_build');
  });

  it('reports no_manifest when the published digest is the empty sentinel', async () => {
    const r = await checkUpdateAvailability({
      manifestJson: manifest('', ''),
      runningContainers: [
        {
          name: 'mailbox-dashboard',
          image: 'mailbox-mailbox-dashboard:latest',
          image_id: 'sha256:configdash',
        },
      ],
    });
    expect(r.update_available).toBe(false);
    const dash = r.services.find((s) => s.service === 'mailbox-dashboard');
    expect(dash?.state).toBe('no_manifest');
  });

  it('reports not_running when the expected container is absent', async () => {
    const r = await checkUpdateAvailability({
      manifestJson: manifest(DASH_DIGEST_A, CADDY_DIGEST),
      runningContainers: [],
    });
    expect(r.update_available).toBe(false);
    const dash = r.services.find((s) => s.service === 'mailbox-dashboard');
    expect(dash?.state).toBe('not_running');
  });
});

describe('checkUpdateAvailability — degraded paths', () => {
  it('degrades with a reason on unparseable manifest JSON', async () => {
    const r = await checkUpdateAvailability({
      manifestJson: 'not-json{',
      runningContainers: [],
    });
    expect(r.update_available).toBe(false);
    expect(r.reason).toMatch(/not valid JSON/);
    expect(r.services).toEqual([]);
  });

  it('degrades with the docker reason when the socket is unavailable', async () => {
    const r = await checkUpdateAvailability({
      manifestJson: manifest(DASH_DIGEST_A, CADDY_DIGEST),
      runningContainers: { unavailable: 'docker socket /var/run/docker.sock not present' },
    });
    expect(r.update_available).toBe(false);
    expect(r.reason).toMatch(/docker socket/);
  });
});
