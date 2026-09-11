import { join } from 'node:path';
import {
  PROJECT_REGISTRY_FILE,
  ReticleDir,
  emptyProjectRegistry,
  parseProjectRegistry,
  rememberProject,
} from '@reticlehq/core';

/**
 * Record where this project lives, so a daemon started somewhere else can still find it.
 *
 * Called at the end of `init`, which is the one moment both halves are known for certain: the
 * directory being initialised, and the projectId that was just written into its `.reticle.json`.
 *
 * Deliberately runs on EVERY init, not only the first. Most init runs report "already wired", and a
 * re-run in a re-cloned or moved checkout is exactly when the remembered path has gone stale — so
 * the run that would have been a no-op is the one that repairs the entry.
 *
 * Every failure is swallowed. This is a cache that makes a later resolution better; a read-only home
 * directory, a full disk or a hand-mangled file must not turn a successful init into a failed one.
 * The user's project is wired either way, and `init`'s report is the first thing a new user reads.
 */

/** The sync filesystem seam `init` already carries. Narrowed to what this needs. */
export interface RegistryIo {
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  homeDir(): string;
}

/** The `projectId` a `.reticle.json` declares, or undefined when it declares none we can use. */
export function projectIdOf(configSource: string | null): string | undefined {
  if (null === configSource || 0 === configSource.length) return undefined;
  try {
    const parsed: unknown = JSON.parse(configSource);
    if ('object' !== typeof parsed || null === parsed || Array.isArray(parsed)) return undefined;
    const id = (parsed as Record<string, unknown>)['projectId'];
    return 'string' === typeof id && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export function rememberProjectOnDisk(
  io: RegistryIo,
  projectId: string,
  directory: string,
  now: number,
): boolean {
  if (0 === projectId.length || 0 === directory.length) return false;
  try {
    const path = join(io.homeDir(), ReticleDir.ROOT, PROJECT_REGISTRY_FILE);
    const existing = io.exists(path) ? io.readFile(path) : null;
    const registry =
      null === existing ? emptyProjectRegistry() : parseProjectRegistry(safeJson(existing));
    const next = rememberProject(registry, projectId, directory, now);
    io.writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
