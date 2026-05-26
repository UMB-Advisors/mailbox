// MBOX-168 — unit tests for queries-docker.ts.
//
// Same convention as queries-git.test.ts: inject a fake HTTP client so the
// suite runs identically on macOS dev and the Jetson without needing a
// docker daemon.

import { describe, expect, it, vi } from 'vitest';
import {
  type DockerHttpClient,
  listRunningContainers,
} from '@/lib/queries-docker';

function buildClient(
  fn: (path: string) => Promise<{ statusCode: number; body: string }>,
): DockerHttpClient {
  return (path, _opts) => fn(path);
}

const SAMPLE_RUNNING_BODY = JSON.stringify([
  {
    Id: 'aaaa1111',
    Names: ['/mailbox-dashboard'],
    Image: 'mailbox-mailbox-dashboard:latest',
    State: 'running',
  },
  {
    Id: 'bbbb2222',
    Names: ['/mailbox-n8n-1'],
    Image: 'n8nio/n8n:2.14.2',
    State: 'running',
  },
  {
    Id: 'cccc3333',
    Names: ['/mailbox-postgres-1'],
    Image: 'postgres:17-alpine',
    State: 'running',
  },
]);

describe('listRunningContainers — happy path', () => {
  it('hits /containers/json with the running-only filter', async () => {
    const captured: string[] = [];
    const client = buildClient(async (path) => {
      captured.push(path);
      return { statusCode: 200, body: '[]' };
    });
    await listRunningContainers({ httpClient: client });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatch(/^\/containers\/json\?filters=/);
    // The encoded filter must round-trip back to the canonical JSON.
    const filtersEnc = captured[0].split('filters=')[1];
    expect(decodeURIComponent(filtersEnc)).toBe('{"status":["running"]}');
  });

  it('normalizes Docker name format (strips leading slash) and projects fields', async () => {
    const client = buildClient(async () => ({
      statusCode: 200,
      body: SAMPLE_RUNNING_BODY,
    }));
    const r = await listRunningContainers({ httpClient: client });
    expect(r.available).toBe(true);
    if (!r.available) throw new Error('unexpected unavailable');
    expect(r.containers).toHaveLength(3);
    expect(r.containers[0]).toEqual({
      name: 'mailbox-dashboard',
      image: 'mailbox-mailbox-dashboard:latest',
      state: 'running',
    });
    expect(r.containers.map((c) => c.name)).toEqual([
      'mailbox-dashboard',
      'mailbox-n8n-1',
      'mailbox-postgres-1',
    ]);
  });

  it('returns available: true with an empty array when no containers are running', async () => {
    const client = buildClient(async () => ({ statusCode: 200, body: '[]' }));
    const r = await listRunningContainers({ httpClient: client });
    expect(r.available).toBe(true);
    if (!r.available) throw new Error('unexpected unavailable');
    expect(r.containers).toEqual([]);
  });

  it('skips malformed entries (missing Names) rather than throwing', async () => {
    const client = buildClient(async () => ({
      statusCode: 200,
      body: JSON.stringify([
        { Names: ['/good'], Image: 'x', State: 'running' },
        { Image: 'no-names', State: 'running' }, // skipped
        null, // skipped
        { Names: [], State: 'running' }, // skipped (no name string)
      ]),
    }));
    const r = await listRunningContainers({ httpClient: client });
    expect(r.available).toBe(true);
    if (!r.available) throw new Error('unexpected unavailable');
    expect(r.containers).toHaveLength(1);
    expect(r.containers[0].name).toBe('good');
  });
});

describe('listRunningContainers — error classification', () => {
  it('classifies ENOENT as a missing bind-mount with actionable reason', async () => {
    const client = buildClient(async () => {
      const e: NodeJS.ErrnoException = Object.assign(new Error('connect ENOENT'), {
        code: 'ENOENT',
      });
      throw e;
    });
    const r = await listRunningContainers({ httpClient: client });
    expect(r.available).toBe(false);
    if (r.available) throw new Error('unexpected available');
    expect(r.reason).toMatch(/socket .* not present.*bind mount.*docker-compose/);
  });

  it('classifies EACCES as a permission problem', async () => {
    const client = buildClient(async () => {
      const e: NodeJS.ErrnoException = Object.assign(new Error('EACCES'), {
        code: 'EACCES',
      });
      throw e;
    });
    const r = await listRunningContainers({ httpClient: client });
    expect(r.available).toBe(false);
    if (r.available) throw new Error('unexpected available');
    expect(r.reason).toMatch(/permission denied/);
  });

  it('returns unavailable on non-2xx response with the body excerpt', async () => {
    const client = buildClient(async () => ({
      statusCode: 500,
      body: 'internal error something something',
    }));
    const r = await listRunningContainers({ httpClient: client });
    expect(r.available).toBe(false);
    if (r.available) throw new Error('unexpected available');
    expect(r.reason).toMatch(/HTTP 500/);
    expect(r.reason).toMatch(/internal error/);
  });

  it('returns unavailable on non-JSON body', async () => {
    const client = buildClient(async () => ({ statusCode: 200, body: 'not-json' }));
    const r = await listRunningContainers({ httpClient: client });
    expect(r.available).toBe(false);
    if (r.available) throw new Error('unexpected available');
    expect(r.reason).toMatch(/non-JSON/);
  });

  it('returns unavailable on non-array JSON', async () => {
    const client = buildClient(async () => ({ statusCode: 200, body: '{}' }));
    const r = await listRunningContainers({ httpClient: client });
    expect(r.available).toBe(false);
    if (r.available) throw new Error('unexpected available');
    expect(r.reason).toMatch(/non-array/);
  });

  it('passes the configured timeout down to the http client', async () => {
    const seenTimeouts: number[] = [];
    const client: DockerHttpClient = async (_path, opts) => {
      seenTimeouts.push(opts.timeoutMs);
      return { statusCode: 200, body: '[]' };
    };
    await listRunningContainers({ httpClient: client, timeoutMs: 123 });
    expect(seenTimeouts).toEqual([123]);
  });
});
