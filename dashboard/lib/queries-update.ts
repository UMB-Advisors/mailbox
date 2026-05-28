// MBOX-184 — Read-only "Update available" detection (the safe, non-destructive
// half of the OTA story).
//
// What it does: compares the latest GHCR-published image digest for each
// locally-built service (recorded in the committed deploy/image-manifest.json)
// against the digest of the image the corresponding container is ACTUALLY
// running. The result feeds a read-only /status panel — there is NO action
// here. The "Update now" button + pull→recreate→migrate→smoke→commit/rollback
// orchestration is a separate, deferred follow-up (see the MBOX-184 follow-up
// note in the consuming route / page).
//
// Why this is non-destructive: we only READ. The running digests come from the
// same MBOX-168 read-only docker.sock reader (GET /containers/json) — no new
// privileged bind, no docker writes. The manifest is a plain committed JSON
// file read off the existing MBOX-163 read-only repo bind mount.
//
// Identity model — three cases per service, in priority order:
//   1. Running container's `Image` ref carries an @sha256 digest (GHCR
//      digest-pinned deploy). Compare that digest to the manifest digest.
//      Equal → up_to_date. Differ → update_available.
//   2. Running container's `Image` ref is a tag-only LOCAL build (M1's
//      `docker compose up -d --build` path → `mailbox-mailbox-dashboard:latest`,
//      no digest). We CANNOT prove equality against a registry manifest digest
//      from a local config id, so we report `local_build` (informational, not a
//      false "update available"). This keeps M1's current path honest.
//   3. Manifest has no published digest yet (pre-first-CI-publish sentinel) →
//      `no_manifest`. Or the container isn't running → `not_running`.
//
// Total-failure-safe contract: this helper NEVER throws. Manifest missing /
// unparseable, docker socket unreachable → a normalized result with a
// per-service `unknown` state and an overall reason. The /status surface relies
// on this (same contract as queries-orphans.ts / queries-docker.ts).

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { type DockerHttpClient, digestFromImageRef, listRunningContainers } from './queries-docker';

const DEFAULT_REPO_MOUNT = '/app/repo';
const DEFAULT_MANIFEST_RELPATH = 'deploy/image-manifest.json';
const DEFAULT_PROJECT_NAME = 'mailbox';

/**
 * Maps a manifest service KEY to the docker-compose SERVICE name it
 * corresponds to. The compose service name is what drives the running
 * container name (`<project>-<service>-1`, or an explicit container_name).
 * Keep this in lockstep with deploy/image-manifest.json `services` keys and
 * the locally-built services in docker-compose.yml.
 */
const MANIFEST_KEY_TO_COMPOSE_SERVICE: Record<string, string> = {
  'mailbox-dashboard': 'mailbox-dashboard',
  'mailbox-caddy': 'caddy',
};

/**
 * Explicit container_name overrides set in docker-compose.yml. When a service
 * declares `container_name`, docker uses it verbatim instead of the
 * `<project>-<service>-1` default. mailbox-dashboard sets one; caddy does not.
 */
const COMPOSE_CONTAINER_NAME_OVERRIDE: Record<string, string> = {
  'mailbox-dashboard': 'mailbox-dashboard',
};

export type ServiceUpdateState =
  | 'up_to_date'
  | 'update_available'
  | 'local_build'
  | 'no_manifest'
  | 'not_running'
  | 'unknown';

export interface ServiceUpdateStatus {
  /** Manifest service key (also the user-facing service label). */
  service: string;
  state: ServiceUpdateState;
  /** Digest the manifest says is the latest published image (sha256:… or null). */
  manifest_digest: string | null;
  /** Git-SHA tag the manifest associates with that digest, if any. */
  manifest_tag: string | null;
  /** Digest the running container is on, when derivable from its image ref. */
  running_digest: string | null;
  /** The raw image ref the container reports (for operator context). */
  running_image: string | null;
  /** Per-service human-readable explanation. */
  detail: string;
}

export interface UpdateAvailability {
  /** True when ANY service is in `update_available`. Drives the panel tone. */
  update_available: boolean;
  services: ServiceUpdateStatus[];
  /** Non-null when the whole check degraded (manifest unreadable, docker down). */
  reason: string | null;
}

export interface CheckUpdateAvailabilityOptions {
  /** Compose project name. Defaults to env COMPOSE_PROJECT_NAME or "mailbox". */
  projectName?: string;
  /**
   * Absolute path to the image manifest. Defaults to
   * $MAILBOX_REPO_MOUNT/deploy/image-manifest.json.
   */
  manifestPath?: string;
  /** Raw manifest JSON text; overrides manifestPath. Primarily for tests. */
  manifestJson?: string;
  /** Inject the docker http client for tests. */
  dockerHttpClient?: DockerHttpClient;
  /**
   * Pre-resolved running containers — bypasses the docker socket entirely.
   * Primarily for tests; production callers leave this unset.
   */
  runningContainers?:
    | Array<{ name: string; image: string }>
    | { unavailable: string };
  /** Per-docker-call timeout. Mirrors queries-docker default. */
  dockerTimeoutMs?: number;
}

interface ManifestServiceEntry {
  repo: string;
  tag: string;
  digest: string;
}

interface ParsedManifest {
  services: Record<string, ManifestServiceEntry>;
}

function projectName(opts: CheckUpdateAvailabilityOptions): string {
  return opts.projectName ?? process.env.COMPOSE_PROJECT_NAME?.trim() ?? DEFAULT_PROJECT_NAME;
}

function manifestFilePath(opts: CheckUpdateAvailabilityOptions): string {
  if (opts.manifestPath) return opts.manifestPath;
  const root = process.env.MAILBOX_REPO_MOUNT?.trim() || DEFAULT_REPO_MOUNT;
  return path.join(root, DEFAULT_MANIFEST_RELPATH);
}

function degraded(reason: string): UpdateAvailability {
  return { update_available: false, services: [], reason };
}

/**
 * Compute the container name docker-compose would assign to a manifest
 * service: an explicit container_name override when set, otherwise the
 * `<project>-<service>-1` default. Exported for direct unit testing.
 */
export function expectedContainerName(manifestKey: string, project: string): string | null {
  const composeService = MANIFEST_KEY_TO_COMPOSE_SERVICE[manifestKey];
  if (!composeService) return null;
  const override = COMPOSE_CONTAINER_NAME_OVERRIDE[manifestKey];
  if (override) return override;
  return `${project}-${composeService}-1`;
}

function parseManifest(text: string): ParsedManifest | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `image manifest is not valid JSON: ${(err as Error).message}` };
  }
  if (!raw || typeof raw !== 'object') {
    return { error: 'image manifest did not parse to an object' };
  }
  const services = (raw as Record<string, unknown>).services;
  if (!services || typeof services !== 'object') {
    return { error: 'image manifest has no `services` object' };
  }
  const out: Record<string, ManifestServiceEntry> = {};
  for (const [key, val] of Object.entries(services as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') continue;
    const v = val as Record<string, unknown>;
    out[key] = {
      repo: typeof v.repo === 'string' ? v.repo : '',
      tag: typeof v.tag === 'string' ? v.tag : '',
      digest: typeof v.digest === 'string' ? v.digest : '',
    };
  }
  return { services: out };
}

/**
 * Read the committed manifest + the running container digests; return the
 * per-service comparison. Never throws.
 */
export async function checkUpdateAvailability(
  opts: CheckUpdateAvailabilityOptions = {},
): Promise<UpdateAvailability> {
  // Phase 1 — load manifest. opts.manifestJson short-circuits the read.
  let manifestText: string;
  if (opts.manifestJson !== undefined) {
    manifestText = opts.manifestJson;
  } else {
    const manifestPath = manifestFilePath(opts);
    try {
      manifestText = await readFile(manifestPath, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return degraded(
          `image manifest ${manifestPath} not present — is the host repo bind-mounted at $MAILBOX_REPO_MOUNT?`,
        );
      }
      return degraded(`failed to read image manifest ${manifestPath}: ${e.message}`);
    }
  }

  const parsed = parseManifest(manifestText);
  if ('error' in parsed) {
    return degraded(parsed.error);
  }

  // Phase 2 — running containers, keyed by name. Tests can short-circuit.
  let running: Array<{ name: string; image: string }>;
  if (opts.runningContainers !== undefined) {
    if (Array.isArray(opts.runningContainers)) {
      running = opts.runningContainers;
    } else {
      return degraded(opts.runningContainers.unavailable);
    }
  } else {
    const list = await listRunningContainers({
      httpClient: opts.dockerHttpClient,
      timeoutMs: opts.dockerTimeoutMs,
    });
    if (!list.available) {
      return degraded(list.reason);
    }
    running = list.containers;
  }
  const byName = new Map(running.map((c) => [c.name, c]));

  // Phase 3 — per-service comparison.
  const project = projectName(opts);
  const services: ServiceUpdateStatus[] = [];
  let anyUpdate = false;

  for (const [key, entry] of Object.entries(parsed.services)) {
    const manifestDigest = entry.digest.trim() || null;
    const manifestTag = entry.tag.trim() || null;
    const containerName = expectedContainerName(key, project);
    const container = containerName ? byName.get(containerName) : undefined;
    const runningImage = container?.image ?? null;
    const runningDigest = runningImage ? digestFromImageRef(runningImage) : null;

    let state: ServiceUpdateState;
    let detail: string;

    if (manifestDigest === null) {
      state = 'no_manifest';
      detail = 'no published bundle yet — CI has not published this service to GHCR';
    } else if (!container) {
      state = 'not_running';
      detail = containerName
        ? `expected container ${containerName} is not running`
        : `no compose-service mapping for manifest key ${key}`;
    } else if (runningDigest === null) {
      // Tag-only local build (M1's `up -d --build` path). We can't prove
      // equality against a registry digest, so report local_build — NOT a
      // false update_available.
      state = 'local_build';
      detail = `running a local build (${runningImage}) — not GHCR digest-pinned, so update comparison is N/A`;
    } else if (runningDigest === manifestDigest) {
      state = 'up_to_date';
      detail = 'running the latest published digest';
    } else {
      state = 'update_available';
      detail = `running ${shortDigest(runningDigest)} → latest published is ${shortDigest(manifestDigest)}`;
      anyUpdate = true;
    }

    services.push({
      service: key,
      state,
      manifest_digest: manifestDigest,
      manifest_tag: manifestTag,
      running_digest: runningDigest,
      running_image: runningImage,
      detail,
    });
  }

  return { update_available: anyUpdate, services, reason: null };
}

/**
 * `sha256:abc123def…` → `abc123d` (7 hex chars after the algo prefix), for
 * compact UI rendering. Exported so the page can render short forms without
 * re-implementing the slice. Returns the input unchanged if it isn't a
 * recognizable `sha256:` digest.
 */
export function shortDigest(digest: string | null): string {
  if (!digest) return '—';
  const m = /^sha256:([0-9a-f]+)$/.exec(digest);
  if (!m) return digest;
  return m[1].slice(0, 7);
}
