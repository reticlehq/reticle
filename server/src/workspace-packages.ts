import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceGlobs } from '../../scripts/check-boundaries.mjs';
import { REPO_ROOT } from './machine/repo-root.js';

/**
 * Every package this repository publishes, and where it lives.
 *
 * Several checks need this list: the one that says every integration has an app proving it, the one
 * that keeps the build cache honest, the one that finds slow tests, the one that checks the commands
 * in our own README files. Each used to find the list by reading one directory, `packages/`.
 *
 * That stopped being true. The specification, the rules that decide a verdict and the adapters are
 * grouped by what they are, so a check that reads one directory now sees about half of them -- and
 * goes on passing, which reads as "these are all fine" when it means "most were not looked at". The
 * same mistake was made four separate times in one afternoon.
 *
 * So the list comes from the pnpm workspace file, which is the one place that cannot quietly go
 * stale: it is what the package manager installs from, so a package missing from it does not go
 * unchecked, it stops working.
 *
 * The local fixture apps are left out on purpose. They are never published and are deliberately
 * allowed to depend on anything, which is what makes them useful as fixtures.
 */
export function publishedPackageDirs(): string[] {
  const yaml = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const found: string[] = [];
  for (const glob of workspaceGlobs(yaml)) {
    if (glob.startsWith('apps')) continue;
    const [head, ...rest] = glob.split('/');
    const start = join(REPO_ROOT, head ?? '');
    if (!existsSync(start)) continue;
    collect(start, rest.length, found);
  }
  return found;
}

/** Walk exactly `levels` directories down, keeping anything that has a manifest. */
function collect(dir: string, levels: number, into: string[]): void {
  if (0 === levels) {
    if (existsSync(join(dir, 'package.json'))) into.push(dir);
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) collect(join(dir, entry.name), levels - 1, into);
  }
}

/** The same list, as the last part of each path: `core`, `server`, `dom`, and so on. */
export function publishedPackageNames(): string[] {
  return publishedPackageDirs().map((dir) => dir.split('/').pop() ?? '');
}
