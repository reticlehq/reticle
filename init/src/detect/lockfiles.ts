/**
 * Which lockfile decides the package manager `init` will tell the user to run.
 *
 * Split out of `run.ts` when that file crossed the 1000-line cap: this is one self-contained
 * question with its own test block, and `run.ts` is the orchestration around it.
 */
import { dirname, join } from 'node:path';
import { namesAPackageManager } from './detect.js';
import type { InitIo } from '../run.js';

/** Lockfile basenames, in package-manager preference order (mirrors detect.ts). */
const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'package-lock.json',
] as const;

/**
 * Resolve the lockfiles set used to pick the package manager. A lockfile in the project root wins;
 * otherwise we walk UP the directory tree (monorepos keep the lockfile at the workspace root, not in
 * each package) so `reticle init` in a sub-package suggests `pnpm add` instead of defaulting to `npm i`.
 *
 * The walk is skipped when the project has its own installed tree, because an INHERITED lockfile is
 * weaker evidence than a `node_modules` sitting right there — the ancestor describes the workspace,
 * the tree describes THIS package. Reported from the field: `init` in a `frontend/` app installed
 * with npm emitted `pnpm add -D` off a repo-root `pnpm-lock.yaml`, pnpm was not on PATH, and the
 * failed install took every downstream wiring step with it. A LOCAL lockfile still wins over the
 * tree — it is a deliberate statement about this package, not an inheritance.
 */
export function resolveLockfiles(
  rootFiles: ReadonlySet<string>,
  cwd: string,
  io: Pick<InitIo, 'exists'>,
  nodeModulesMarkers: ReadonlySet<string> = new Set(),
): Set<string> {
  const set = new Set(rootFiles);
  if (LOCKFILE_NAMES.some((name) => set.has(name))) return set; // local lockfile is authoritative
  if (namesAPackageManager(nodeModulesMarkers)) return set;
  let dir = cwd;
  for (let depth = 0; depth < 50; depth++) {
    for (const name of LOCKFILE_NAMES) {
      if (io.exists(join(dir, name))) {
        set.add(name);
        return set;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return set;
}
