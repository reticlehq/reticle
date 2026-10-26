/**
 * Whether git gives a checkout a path, or ignores it. One `git check-ignore` for each path.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** Exit status of `git check-ignore` for a path that git does not ignore. */
const CHECK_IGNORE_NOT_IGNORED = 1;
const GIT_TIMEOUT_MS = 2_000;
const tracked = new Map<string, boolean>();

/**
 * True when git answers that it does not ignore `path`, so a checkout gets the file from git. False
 * when git ignores it, and when git cannot answer. Asked once for each path in this process. `path`
 * need not exist yet.
 */
export function gitTracks(path: string): boolean {
  const known = tracked.get(path);
  if (known !== undefined) return known;
  const result = spawnSync('git', ['check-ignore', '-q', path], {
    cwd: existingAncestor(path),
    stdio: 'ignore',
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  const answer = CHECK_IGNORE_NOT_IGNORED === result.status;
  tracked.set(path, answer);
  return answer;
}

/** `path`, or the nearest directory above it that exists: git needs a real working directory. */
function existingAncestor(path: string): string {
  let dir = dirname(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}
