/**
 * Leased sessions wrote wherever the resolver sent them — `~/.reticle/unmatched/<id>` for an app with
 * no project id — so `reticle try`, a chat drive or a lease opened from a linked folder produced runs
 * nothing linked or synced, and try's wait for its run timed out. A lease now carries the root of
 * whoever opened it, and the session it registers writes there.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { claimArtifactRoot, claimedArtifactRoot, dropArtifactRootClaim } from './root-claims.js';

const ROOT = '/work/shop/.reticle';

afterEach(() => {
  dropArtifactRootClaim('lease-1');
});

describe('artifact root claims', () => {
  it('gives the session registered under the lease id the claimed root', () => {
    claimArtifactRoot('lease-1', ROOT);
    expect(claimedArtifactRoot('lease-1', 'http://localhost:3000/')).toBe(ROOT);
  });

  it('follows the lease marker on the url when the app named its own session', () => {
    claimArtifactRoot('lease-1', ROOT);
    expect(claimedArtifactRoot('app-own', 'http://localhost:3000/?__reticle_session=lease-1')).toBe(
      ROOT,
    );
  });

  it('claims nothing for a session no lease opened', () => {
    claimArtifactRoot('lease-1', ROOT);
    expect(claimedArtifactRoot('tab-9', 'http://localhost:3000/')).toBeUndefined();
  });

  it('refuses a root that is not an absolute .reticle folder', () => {
    expect(() => claimArtifactRoot('lease-1', 'relative/.reticle')).toThrow();
    expect(() => claimArtifactRoot('lease-1', '/work/shop')).toThrow();
  });

  it('forgets the claim when the lease is released', () => {
    claimArtifactRoot('lease-1', ROOT);
    dropArtifactRootClaim('lease-1');
    expect(claimedArtifactRoot('lease-1', 'http://localhost:3000/')).toBeUndefined();
  });
});
