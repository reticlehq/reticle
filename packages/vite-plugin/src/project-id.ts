/**
 * Zero-config project identity for the build plugin.
 *
 * The whole multi-project model hinges on each app carrying a STABLE id that survives the dev server
 * booting on a different port than usual. We derive it once, at config time, from the app's
 * package.json name plus a short hash of its absolute root — human-readable AND unique per checkout,
 * and unchanged when the port shifts. An explicit `projectId` option always overrides.
 */

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { PROJECT_ID_HASH_LENGTH, projectIdFrom } from '@reticlehq/core';

export { slugifyPackageName } from '@reticlehq/core';

/** A short, stable hex fingerprint of the absolute project root (disambiguates same-named checkouts). */
export function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, PROJECT_ID_HASH_LENGTH);
}

/**
 * Derive the stable projectId from the package name (may be undefined) and the absolute root path.
 *
 * The rule itself is core's `projectIdFrom`, shared with `reticle init`: this id is what scopes a
 * session to an app, so what the plugin stamps and what init records must be the same string. They
 * used to be two identical copies kept in step by a comment.
 */
export function deriveProjectId(pkgName: string | undefined, rootPath: string): string {
  return projectIdFrom(pkgName, rootPath, shortHash);
}

/** Read the `name` from the nearest package.json at or above `startDir`, or undefined if none. */
function readNearestPackageName(startDir: string): string | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 50; depth++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if ('object' === typeof parsed && parsed !== null) {
          const name = (parsed as Record<string, unknown>)['name'];
          if ('string' === typeof name && name.length > 0) return name;
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
