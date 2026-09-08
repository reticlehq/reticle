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
import { readFileSync } from 'node:fs';
import { PROJECT_ID_HASH_LENGTH, projectIdFrom } from '@reticlehq/core';

/** The project config `reticle init` writes, and the id of record it carries. */
const RETICLE_CONFIG_BASENAME = '.reticle.json';

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

/** Reads a file, or throws — the one filesystem touch these walkers make, injectable for tests. */
type ReadFile = (path: string) => string;

const readFileOrThrow: ReadFile = (path) => readFileSync(path, 'utf8');

/**
 * Walk up from `startDir` looking for `basename`, and return the first non-empty string `field`
 * yields. Unreadable and unparseable files are skipped rather than fatal: a dev server must start.
 */
function readNearestField(
  startDir: string,
  basename: string,
  field: string,
  readFile: ReadFile,
): string | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 50; depth++) {
    try {
      const parsed: unknown = JSON.parse(readFile(join(dir, basename)));
      if ('object' === typeof parsed && parsed !== null) {
        const value = (parsed as Record<string, unknown>)[field];
        if ('string' === typeof value && value.length > 0) return value;
      }
    } catch {
      // missing, unreadable or unparseable → keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return undefined;
}

/** Read the `name` from the nearest package.json at or above `startDir`, or undefined if none. */
function readNearestPackageName(
  startDir: string,
  readFile: ReadFile = readFileOrThrow,
): string | undefined {
  return readNearestField(startDir, 'package.json', 'name', readFile);
}

/**
 * Read the `projectId` `reticle init` recorded in the nearest `.reticle.json`, or undefined.
 *
 * This is the id of RECORD. The derivation below is a fallback for a project that has never been
 * through `init` — it is not a second opinion, and where the two disagree the config wins.
 */
export function readConfiguredProjectId(
  startDir: string,
  readFile: ReadFile = readFileOrThrow,
): string | undefined {
  return readNearestField(startDir, RETICLE_CONFIG_BASENAME, 'projectId', readFile);
}

/**
 * Resolve the projectId for a plugin instance, most-local statement of intent first: an explicit
 * option, then the id `reticle init` recorded in `.reticle.json`, then derivation.
 *
 * The config step is what makes the id survive a dev server that does not share a filesystem with
 * the CLI. Derivation hashes the ABSOLUTE ROOT, so a containerised Vite (`/app`) and the host `init`
 * that wired it produce different ids for one project — the page announces one, the daemon expects
 * the other, and the bridge refuses the connection with `authentication failed`, which names
 * neither. Reading the file `init` already wrote costs one `readFileSync` at config time and makes
 * the two halves agree by construction rather than by coincidence of working directory.
 *
 * `cwd`, `readPkgName` and `readConfiguredId` are injectable so resolution is unit-tested without
 * touching the real filesystem.
 */
export function resolveProjectId(
  explicit: string | undefined,
  cwd: string,
  readPkgName: (dir: string) => string | undefined = readNearestPackageName,
  readConfiguredId: (dir: string) => string | undefined = readConfiguredProjectId,
): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const configured = readConfiguredId(cwd);
  if (configured !== undefined && configured.length > 0) return configured;
  return deriveProjectId(readPkgName(cwd), cwd);
}
