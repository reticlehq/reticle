import { execFileSync } from 'node:child_process';

/**
 * Where this repository starts on disk.
 *
 * Many checks in this package read files that live outside it -- the workflow file, the docs, the
 * skill, the benchmark scenarios -- and to do that they need the top of the repository.
 *
 * Asks git, because a fixed count of `..` segments is a fact about this package's depth, not about
 * the repository: when the package moved, every count was off by one and each check quietly read a
 * directory that does not exist. This file sits at a fixed place INSIDE the package, so the way its
 * neighbours reach it never changes however far the package itself moves.
 *
 * Example: a check that wants the workflow file writes
 * `join(REPO_ROOT, '.github', 'workflows', 'ci.yml')`, and keeps working wherever this package ends
 * up.
 */
export const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: import.meta.dirname,
  encoding: 'utf8',
}).trim();
