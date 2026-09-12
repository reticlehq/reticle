import { join } from 'node:path';
import {
  PROJECT_REGISTRY_FILE,
  ReticleDir,
  ProjectRegistrySchema,
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
    if (null === existing) {
      io.writeFile(
        path,
        `${JSON.stringify(rememberProject(emptyProjectRegistry(), projectId, directory, now), null, 2)}\n`,
      );
      return true;
    }

    // A registry from a version we do not know is left EXACTLY as it is.
    //
    // Reading one falls back to an empty registry, and for reading that is right: a cache the daemon
    // cannot understand is one it does without, and it finds the project by looking instead. Writing
    // that emptiness back is a different act. It turns one file we could not parse into one file
    // holding a single project, and every other project the user has set up is gone -- during
    // `init`, which is what somebody runs right after upgrading.
    //
    // Failing here costs nothing, which is the point. The caller ignores the result and this is a
    // cache that makes a later lookup faster, so a swallowed failure should leave things as they
    // were rather than tidy them away.
    //
    // A file that is not JSON at all is a different case and IS replaced. There is nothing in it to
    // keep, nobody can repair `{ half a file` by hand, and refusing would mean this user's projects
    // are never recorded again -- silently, because failures here are swallowed by design.
    const raw = safeJson(existing);
    if (fromAnotherVersion(raw)) return false;
    const registry = parseProjectRegistry(raw);
    const next = rememberProject(registry, projectId, directory, now);
    io.writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this a registry written by a Reticle that is not this one?
 *
 * True only when the file parsed as JSON and declares a version we do not use. A file that is not
 * JSON, or declares no version, is damage rather than a message from another release.
 */
function fromAnotherVersion(raw: unknown): boolean {
  if ('object' !== typeof raw || null === raw) return false;
  const version = (raw as { version?: unknown }).version;
  return 'number' === typeof version && !ProjectRegistrySchema.safeParse(raw).success;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
