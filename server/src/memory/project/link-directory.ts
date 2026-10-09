/**
 * The directory `reticle link` binds: the project a session from here would write its runs into.
 *
 * Runs land in the root the artifact resolver picks for the page's project, which comes from the same
 * config discovery used here. Binding `cwd` instead left a monorepo's `apps/web/.reticle` unlinked
 * while every run of that app landed in it.
 */
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import {
  discoverProjectConfigs,
  hasProjectConfig,
  type ConfigDiscovery,
} from '@/command/cli/config/config-discovery.js';

/** `inner` is `outer` or sits inside it. */
const within = (inner: string, outer: string): boolean =>
  inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);

/**
 * The declared project that encloses `cwd`, else the one project declared below it, else `cwd`
 * itself. Several candidates below and none enclosing is a choice the caller must make, so `cwd` is
 * kept rather than one picked silently.
 */
export function linkDirectoryFor(cwd: string, discovery: ConfigDiscovery): string {
  const here = resolve(cwd);
  const enclosing = discovery.found
    .map((found) => found.directory)
    .filter((directory) => within(here, directory))
    .sort((a, b) => b.length - a.length)[0];
  if (enclosing !== undefined) return enclosing;
  const below = discovery.found.filter((found) => within(found.directory, here));
  const only = 1 === below.length ? below[0] : undefined;
  return only === undefined ? here : only.directory;
}

/**
 * The `.reticle` a command run here owns: the project's, when this folder is in or above exactly one
 * declared project or already holds a `.reticle`. Undefined anywhere else, so a lease opened from a
 * home directory never plants a `.reticle` in it.
 */
export function callerArtifactRoot(cwd: string): string | undefined {
  const dir = linkDirectoryFrom(cwd);
  const root = join(dir, ReticleDir.ROOT);
  return hasProjectConfig(dir) || existsSync(root) ? root : undefined;
}

/** `linkDirectoryFor` over this machine's own discovery from `cwd`. */
export function linkDirectoryFrom(cwd: string): string {
  return linkDirectoryFor(cwd, discoverProjectConfigs(cwd));
}
