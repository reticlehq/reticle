import { execFileSync } from 'node:child_process';

/**
 * Where this repository starts on disk.
 *
 * Many checks in this package read files that live outside it -- the workflow file, the docs, the
 * skill, the benchmark scenarios -- and to do that they need the top of the repository.
 *
 * They used to find it by walking up a fixed number of directories: four `..` segments from a file
 * two levels inside `src`. That is not a fact about the repository, it is a fact about how deeply
 * this package happens to sit, and packages move. When one did, every count was off by one and each
 * check quietly started reading a directory that does not exist -- which, depending on the check,
 * either threw or passed on nothing.
 *
 * Git already knows the answer, so it is asked once here instead. This file sits at a fixed place
 * INSIDE the package, so the way its neighbours reach it never changes however far the package
 * itself moves.
 *
 * Example: a check that wants the workflow file writes
 * `join(REPO_ROOT, '.github', 'workflows', 'ci.yml')`, and keeps working wherever this package ends
 * up.
 */
export const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: import.meta.dirname,
  encoding: 'utf8',
}).trim();
