/**
 * A dev server started before the daemon connects nothing, and says nothing.
 *
 * The pairing token is read from disk ONCE, when Vite resolves its config, and inlined as
 * `__RETICLE_TOKEN__`. The daemon provisions that file. So a dev server started first — which is the
 * common order, and what an automated harness does — bakes in an EMPTY token. The app then loads the
 * SDK, opens the WebSocket, gets refused by the bridge, and no session ever appears.
 *
 * Every visible signal says things are working: the module loaded, the socket opened. That is the
 * exact signature reported from a SvelteKit fixture — "SDK module loaded: true, bridge socket
 * opened: true, page never fires load, no session" — reproduced three times across two harnesses.
 *
 * A build-time condition that guarantees a runtime failure has to be said at build time. Restarting
 * the dev server is the fix, and nothing else in the stack can tell the user that.
 */

import { describe, expect, it } from 'vitest';
import { missingTokenWarning } from './missing-token.js';

describe('an empty pairing token at config time', () => {
  it('warns, naming the consequence and the fix', () => {
    const warning = missingTokenWarning(undefined);
    expect(warning).toBeDefined();
    expect(warning?.toLowerCase()).toContain('no session');
    expect(warning?.toLowerCase()).toContain('restart');
  });

  it('treats an empty string the same as absent — it is the same failure', () => {
    expect(missingTokenWarning('')).toBeDefined();
  });

  it('stays quiet when the token is there', () => {
    expect(missingTokenWarning('abc123')).toBeUndefined();
  });
});
