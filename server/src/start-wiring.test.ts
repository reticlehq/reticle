/**
 * A lease opened with `root` (a chat drive, `reticle try`, `verify` from a linked folder) wrote its
 * runs, flows and screenshots into that root. Sync never sent them: it read only discovered,
 * registered and announced projects, and the claim lived only in memory. The claimed root is now one
 * of the roots sync considers, after the lease is released too.
 */
import { describe, expect, it } from 'vitest';
import { knownProjectRoots } from './start-wiring.js';
import { claimArtifactRoot, dropArtifactRootClaim } from './memory/project/root-claims.js';

const CLAIMED = '/work/claimed-shop/.reticle';

describe('knownProjectRoots', () => {
  it('includes a root a lease claimed, after the lease is released, once', () => {
    claimArtifactRoot('lease-a', CLAIMED);
    claimArtifactRoot('lease-b', CLAIMED);
    dropArtifactRootClaim('lease-a');
    dropArtifactRootClaim('lease-b');
    expect(knownProjectRoots().filter((root) => root === CLAIMED)).toEqual([CLAIMED]);
  });
});
