/**
 * Zero-config project identity for the build plugin.
 *
 * The whole multi-project model hinges on each app carrying a STABLE id that survives the dev server
 * booting on a different port than usual. We derive it once, at config time, from the app's
 * package.json name plus a short hash of its absolute root — human-readable AND unique per checkout,
 * and unchanged when the port shifts. An explicit `projectId` option always overrides.
 */

import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Turn a package name into an id-safe slug: scoped names lose the `@scope/` punctuation
 * (`@acme/web` → `acme-web`), everything non-alphanumeric collapses to single dashes, edges trimmed.
 */
export function slugifyPackageName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A short, stable hex fingerprint of the absolute project root (disambiguates same-named checkouts). */
export function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 8);
}

/**
 * Derive the stable projectId from the package name (may be undefined) and the absolute root path.
 * Pure — both inputs are passed in. Falls back to the root's folder name, then to "app".
 */
export function deriveProjectId(pkgName: string | undefined, rootPath: string): string {
  const fromName = pkgName !== undefined ? slugifyPackageName(pkgName) : '';
  const base = fromName.length > 0 ? fromName : slugifyPackageName(basename(rootPath)) || 'app';
  return `${base}-${shortHash(rootPath)}`;
}

/** Read the `name` from the nearest package.json at or above `startDir`, or undefined if none. */
export function readNearestPackageName(startDir: string): string | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 50; depth++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null) {
          const name = (parsed as Record<string, unknown>)['name'];
          if (typeof name === 'string' && name.length > 0) return name;
        }
      } catch {
        // unreadable package.json → keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return undefined;
}

/**
 * Resolve the projectId for a plugin instance: an explicit option wins; otherwise derive from the
 * app's package.json name + root. `cwd` and `readPkgName` are injectable so the resolution is
 * unit-tested without touching the real filesystem.
 */
export function resolveProjectId(
  explicit: string | undefined,
  cwd: string,
  readPkgName: (dir: string) => string | undefined = readNearestPackageName,
): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return deriveProjectId(readPkgName(cwd), cwd);
}
