/**
 * Project-identity for `reticle init` — the `.reticle.json` side of the scheme the Vite plugin
 * stamps at build time. The RULE lives in `@reticlehq/core` (projectIdFrom) so both sides spell the
 * id the same way by construction; this file supplies only the Node-only hashing it needs.
 */

import { createHash } from 'node:crypto';
import { PROJECT_ID_HASH_LENGTH, projectIdFrom } from '@reticlehq/core';

export { slugifyPackageName } from '@reticlehq/core';

/** Short, stable hex fingerprint of the absolute project root. */
export function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, PROJECT_ID_HASH_LENGTH);
}

/** Derive the stable projectId from the package name (may be undefined) and the absolute root path. */
export function deriveProjectId(pkgName: string | undefined, rootPath: string): string {
  return projectIdFrom(pkgName, rootPath, shortHash);
}

/** Pull a string `name` out of an already-parsed package.json object, or undefined. */
export function packageName(pkg: unknown): string | undefined {
  if ('object' === typeof pkg && pkg !== null) {
    const name = (pkg as Record<string, unknown>)['name'];
    if ('string' === typeof name && name.length > 0) return name;
  }
  return undefined;
}
