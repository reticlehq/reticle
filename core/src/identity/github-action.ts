/**
 * The GitHub Action tag that users pin. The docs and the cloud's setup card print this one line.
 * `scripts/set-version.mjs` writes the version on each release, and `version-lockstep.test.ts`
 * fails when a doc pins another tag.
 */
export const RETICLE_ACTION_VERSION = '3.9.0';

export const RETICLE_ACTION_USES = `reticlehq/reticle/action@v${RETICLE_ACTION_VERSION}`;
