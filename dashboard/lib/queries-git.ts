// MBOX-163 — Surface the live git state of the mounted appliance repo on
// /api/system/status so operators (and agents on other Claude sessions) can
// verify the box is actually on the branch they think before issuing
// `git pull` / `docker compose up`.
//
// Background: STAQPRO-336 — M1 sat on `worktree-staqpro-360` at `198e105`
// for 36 hours with local `master` 19 commits behind origin. A `git pull`
// in that state was a no-op (different branch). Eric burned a rebuild
// before noticing. Without a way to inspect appliance git state from off
// the box, the only diagnostic was an SSH session.
//
// Bind mount: the host repo is mounted read-only at $MAILBOX_REPO_MOUNT
// (default `/app/repo`) — see docker-compose.yml `mailbox-dashboard.volumes`.
// `:ro` means we MUST NEVER attempt a git write; all callers here are
// strictly read-only plumbing commands.
//
// Subprocess safety: we use `execFile` (not `exec`) with `-C <repo>` so
// the path is a positional arg, not shell-interpolated. The repo path
// comes from env at module load time, so even a malicious `MAILBOX_REPO_MOUNT`
// would land as an execFile arg, not a shell token.

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface GitState {
  available: boolean; // false → repo mount missing / not a git repo / git unavailable
  git_branch: string | null; // 'master' | 'HEAD detached at <short>'
  git_short_sha: string | null;
  git_full_sha: string | null;
  commits_behind_master: number | null; // origin/master..HEAD distance; null if no upstream
  commits_ahead_master: number | null; // HEAD..origin/master distance; null if no upstream
  fetch_age_seconds: number | null; // null if FETCH_HEAD missing (never fetched)
  dirty: boolean | null; // any uncommitted local changes; null if unavailable
  reason: string | null; // populated when available=false
}

// Injectable git runner — accepts (args[]) and returns stdout. Default
// invokes git via execFile bound to the configured repo path. Tests inject
// a mock to assert behavior without spawning subprocesses.
export type GitRunner = (args: string[]) => Promise<string>;

const DEFAULT_REPO_MOUNT = '/app/repo';
const GIT_TIMEOUT_MS = 400; // per-call cap; outer Promise.race caps the helper as a whole

function repoMount(): string {
  return process.env.MAILBOX_REPO_MOUNT?.trim() || DEFAULT_REPO_MOUNT;
}

function makeDefaultRunner(repo: string): GitRunner {
  return async (args: string[]) => {
    const { stdout } = await execFileP('git', ['-C', repo, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    return stdout;
  };
}

const UNAVAILABLE_BASE: Omit<GitState, 'reason'> = {
  available: false,
  git_branch: null,
  git_short_sha: null,
  git_full_sha: null,
  commits_behind_master: null,
  commits_ahead_master: null,
  fetch_age_seconds: null,
  dirty: null,
};

function unavailable(reason: string): GitState {
  return { ...UNAVAILABLE_BASE, reason };
}

// Recognize the "I can't find the repo" failure modes so we can degrade
// gracefully instead of bubbling a thrown error. ENOENT covers a missing
// `git` binary OR a missing repo path; "not a git repository" covers a
// path that exists but isn't initialized (dev workstation forgot the mount).
function isUnavailableError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return true;
    const msg = err.message || '';
    if (msg.includes('not a git repository')) return true;
    if (msg.includes('does not exist')) return true;
  }
  return false;
}

interface GetGitStateOptions {
  runner?: GitRunner;
  repoPath?: string;
  // Skip the up-front mount existence stat. Tests that inject a runner don't
  // need a real on-disk directory.
  skipMountCheck?: boolean;
}

/**
 * Read the appliance's live git state. Total-failure-safe: never throws.
 * Caller (route handler) wraps in Promise.race with a timeout — see
 * dashboard/app/api/system/status/route.ts.
 */
export async function getGitState(opts: GetGitStateOptions = {}): Promise<GitState> {
  const repo = opts.repoPath ?? repoMount();
  const runner = opts.runner ?? makeDefaultRunner(repo);

  // Phase 1 — confirm the repo mount is present + is a git repo. Bail early
  // (and cheaply) if it isn't, with an operator-readable reason.
  if (!opts.skipMountCheck) {
    try {
      const s = await stat(repo);
      if (!s.isDirectory()) {
        return unavailable(`repo mount ${repo} is not a directory`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return unavailable(`repo mount ${repo} not present`);
      }
      return unavailable(`repo mount ${repo} stat failed: ${(err as Error).message}`);
    }
  }

  // Phase 2 — resolve HEAD. `git rev-parse HEAD` is the cheapest "is this
  // a git repo?" probe; if it fails we degrade to unavailable rather than
  // letting downstream calls all fail in parallel.
  let fullSha: string;
  try {
    fullSha = (await runner(['rev-parse', 'HEAD'])).trim();
  } catch (err) {
    if (isUnavailableError(err)) {
      return unavailable(`${repo} is not a git repository`);
    }
    return unavailable(`git rev-parse HEAD failed: ${(err as Error).message}`);
  }
  const shortSha = fullSha.slice(0, 7);

  // Phase 3 — branch. `symbolic-ref --short HEAD` returns non-zero on a
  // detached HEAD; the spec wants 'HEAD detached at <short>' for that case.
  let branch: string;
  try {
    branch = (await runner(['symbolic-ref', '--short', 'HEAD'])).trim();
  } catch {
    branch = `HEAD detached at ${shortSha}`;
  }

  // Phase 4 — independent reads in parallel (each is small + already
  // bounded by GIT_TIMEOUT_MS). settle-all so a single failure doesn't
  // poison the rest.
  const [behindRes, aheadRes, dirtyRes, fetchAtRes] = await Promise.allSettled([
    runner(['rev-list', '--count', 'origin/master..HEAD']),
    runner(['rev-list', '--count', 'HEAD..origin/master']),
    runner(['status', '--porcelain']),
    // FETCH_HEAD timestamp via `git show -s --format=%ct FETCH_HEAD`
    // (commit-time of the fetched ref). Stable across coreutils/BSD `stat`
    // differences. Falls back to fs.stat on .git/FETCH_HEAD if git can't
    // resolve it (some FETCH_HEAD lines aren't a commit ref).
    runner(['show', '-s', '--format=%ct', 'FETCH_HEAD']),
  ]);

  // Behind / ahead are NULL together if origin/master is missing. We swap
  // the semantics: "behind master" = HEAD..origin/master (how many commits
  // origin has that we don't), "ahead master" = origin/master..HEAD.
  // First rev-list call above is "ahead", second is "behind" — see spec
  // contract in the issue; we return them under those keys explicitly.
  const aheadCount = parseRevCount(behindRes); // origin/master..HEAD → ahead
  const behindCount = parseRevCount(aheadRes); // HEAD..origin/master → behind

  const dirty = dirtyRes.status === 'fulfilled' ? dirtyRes.value.length > 0 : null;

  let fetchAgeSeconds: number | null = null;
  if (fetchAtRes.status === 'fulfilled') {
    const ts = Number.parseInt(fetchAtRes.value.trim(), 10);
    if (Number.isFinite(ts) && ts > 0) {
      fetchAgeSeconds = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    }
  } else if (!opts.skipMountCheck) {
    // Fallback: stat .git/FETCH_HEAD mtime directly. Only attempted when we
    // know the mount is real (skipMountCheck=false means we already stat'd).
    try {
      const s = await stat(path.join(repo, '.git', 'FETCH_HEAD'));
      fetchAgeSeconds = Math.max(0, Math.floor((Date.now() - s.mtimeMs) / 1000));
    } catch {
      fetchAgeSeconds = null;
    }
  }

  return {
    available: true,
    git_branch: branch,
    git_short_sha: shortSha,
    git_full_sha: fullSha,
    commits_behind_master: behindCount,
    commits_ahead_master: aheadCount,
    fetch_age_seconds: fetchAgeSeconds,
    dirty,
    reason: null,
  };
}

function parseRevCount(res: PromiseSettledResult<string>): number | null {
  if (res.status !== 'fulfilled') return null; // origin/master missing → null
  const n = Number.parseInt(res.value.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
