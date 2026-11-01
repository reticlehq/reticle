/**
 * Which `.reticle` a leased session writes into, when whoever opened the lease said so.
 *
 * The resolver can only go on the page's project id and origin, and a page with no project id lands
 * in `~/.reticle/unmatched/`, which nothing links or syncs. A lease opened by `reticle try`, a chat
 * drive or `verify` from a linked folder knows better: the run belongs to the folder that asked.
 *
 * Keyed by the lease id, which the leased tab carries as `__reticle_session` on its url, so a
 * reconnect after a navigation, or an app that names its own session, still finds the claim. Lives
 * until the lease is released.
 */
import { statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { RETICLE_URL_PARAM, ReticleDir } from '@reticlehq/core';

const claims = new Map<string, string>();
/** Every root claimed in this process. Kept after release, so sync still sends what the lease wrote. */
const everClaimed = new Set<string>();

/**
 * The `.reticle` folder a caller meant by `root`. Agents pass the project folder, the one they work
 * in, so a folder that holds a `.reticle` stands for it — and so does any existing directory, since
 * a fresh worktree has none until the first run writes one, the same way a `.reticle` path is
 * accepted before it exists. A path nowhere on disk is the caller's to fix, and the refusals name
 * the path to pass. Openings exported so error-recovery classifies both as the caller's mistake.
 */
export const ARTIFACT_ROOT_ABSOLUTE_REFUSAL = `root must be an absolute path to a ${ReticleDir.ROOT} folder`;
export const ARTIFACT_ROOT_MISSING_REFUSAL = `root must be an existing directory, or the ${ReticleDir.ROOT} folder inside one`;

function resolveArtifactRoot(root: string): string {
  if (!isAbsolute(root)) {
    throw new Error(`${ARTIFACT_ROOT_ABSOLUTE_REFUSAL}, got ${root}`);
  }
  if (ReticleDir.ROOT === basename(root)) {
    return root;
  }
  const inside = join(root, ReticleDir.ROOT);
  if (isDirectory(inside) || isDirectory(root)) {
    return inside;
  }
  throw new Error(`${ARTIFACT_ROOT_MISSING_REFUSAL}, got ${root}. Pass ${inside}`);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Claim `root` for the session a lease registers. Takes a `.reticle` folder or the project folder holding one. */
export function claimArtifactRoot(leaseId: string, root: string): void {
  const resolved = resolveArtifactRoot(root);
  claims.set(leaseId, resolved);
  everClaimed.add(resolved);
}

/** Every root a lease claimed in this process, released or not. Sync reads it to find the work. */
export function claimedArtifactRoots(): string[] {
  return [...everClaimed];
}

/** The root claimed for this session, by its id or by the lease marker on its url. */
export function claimedArtifactRoot(
  sessionId: string,
  url: string | undefined,
): string | undefined {
  const direct = claims.get(sessionId);
  if (direct !== undefined) {
    return direct;
  }
  if (url === undefined) {
    return undefined;
  }
  try {
    const lease = new URL(url).searchParams.get(RETICLE_URL_PARAM.SESSION);
    return null === lease ? undefined : claims.get(lease);
  } catch {
    return undefined;
  }
}

/** Forget a lease's claim, once the lease is released. */
export function dropArtifactRootClaim(leaseId: string): void {
  claims.delete(leaseId);
}
