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
import { basename, isAbsolute } from 'node:path';
import { RETICLE_URL_PARAM, ReticleDir } from '@reticlehq/core';

const claims = new Map<string, string>();

/** Claim `root` for the session a lease registers. Refuses anything but an absolute `.reticle`. */
export function claimArtifactRoot(leaseId: string, root: string): void {
  if (!isAbsolute(root) || ReticleDir.ROOT !== basename(root))
    throw new Error(`root must be an absolute path to a ${ReticleDir.ROOT} folder, got ${root}`);
  claims.set(leaseId, root);
}

/** The root claimed for this session, by its id or by the lease marker on its url. */
export function claimedArtifactRoot(
  sessionId: string,
  url: string | undefined,
): string | undefined {
  const direct = claims.get(sessionId);
  if (direct !== undefined) return direct;
  if (url === undefined) return undefined;
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
