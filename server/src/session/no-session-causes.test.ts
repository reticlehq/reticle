/**
 * The hint led with a cause that was almost never the cause.
 *
 * Across a batch of field reports on four different apps, the lease and no-session hints modelled
 * exactly two causes — no SDK, or a wrong port — and the port was correct every single time.
 * `reticle init` would have been the wrong action every single time, and in several of those
 * reports the agent gave up and told its human that Reticle was not set up on an app that was
 * correctly wired.
 *
 * The causes that DID occur, and that nothing modelled:
 *
 *   1. the SDK is present but `connect()` is never reached (a plugin guard returning early)
 *   2. the dev server predates the SDK, so the plugin is not in the bundle — for Nuxt this is the
 *      MOST likely cause, because Nuxt does not register a new plugin on HMR
 *   3. the handshake was refused at the origin gate, page-side, leaving no trace anywhere
 *   4. a peer dependency is missing, so the dynamic import fails silently
 *   5. the daemon's cwd is not the project
 *
 * And the daemon contradicted itself inside one response: `reticle_sessions` said a session HAD
 * connected earlier "so the wiring is correct", while a lease seconds later said the usual cause was
 * a port mismatch. It already held the evidence against its own hint.
 *
 * These tests pin the ranking: what the daemon KNOWS goes first, and a cause it has positive
 * evidence against is not printed at all.
 */

import { describe, expect, it } from 'vitest';
import { diagnoseNoSession } from './no-session-diagnosis.js';

describe('a daemon that restarted does not claim the install never worked', () => {
  it('separates "restarted and lost state" from "never seen one"', () => {
    const why = diagnoseNoSession({
      everConnected: false,
      previouslyConnected: true,
      initialized: true,
      listening: [3000],
      port: 4400,
    });
    expect(why).toMatch(/restart|earlier|before|previous/i);
    expect(why).not.toMatch(/never seen one/i);
  });

  it('leads with the SDK failing to initialise, because the wiring is proven', () => {
    const why = diagnoseNoSession({
      everConnected: false,
      previouslyConnected: true,
      initialized: true,
      listening: [3000],
      port: 4400,
    });
    expect(why).toMatch(/initiali[sz]e/i);
    // Proven wiring. Re-running init cannot help and can overwrite a working config.
    expect(why).not.toContain('reticle init');
  });

  it('keeps "never seen one" when it is actually true', () => {
    const why = diagnoseNoSession({
      everConnected: false,
      previouslyConnected: false,
      initialized: true,
      listening: [3000],
      port: 4400,
    });
    expect(why).toMatch(/never seen one/i);
  });

  it('does not soften the claim on the strength of ANOTHER project on the same port', () => {
    // previouslyConnected is asked per project. An unrelated app on 4400 is not evidence about this
    // one, and treating it as evidence would be the same over-confident claim in the other direction.
    const why = diagnoseNoSession({
      everConnected: false,
      previouslyConnected: false,
      initialized: true,
      listening: [],
      port: 4400,
    });
    expect(why).not.toMatch(/restarted/i);
  });
});

describe('the causes that actually occur are named', () => {
  const wired = {
    everConnected: false,
    initialized: true,
    listening: [3000],
    port: 4400,
  } as const;

  it('names an SDK that loads but never reaches connect()', () => {
    expect(diagnoseNoSession(wired)).toMatch(/connect\(\)/);
  });

  it('names a dev server started before the SDK was added', () => {
    expect(diagnoseNoSession(wired)).toMatch(/restart the dev server|before the plugin|predates/i);
  });

  it('names a missing peer dependency as a silent dynamic-import failure', () => {
    expect(diagnoseNoSession(wired)).toMatch(/@reticlehq\/react/);
  });

  it('still names the non-localhost origin gate, and that a token is needed too', () => {
    const why = diagnoseNoSession(wired);
    expect(why).toContain('allowNonLocalhost');
    // The reporter who recovered this rule by grepping our own dist found that the flag ALONE is
    // not sufficient off localhost: a pairing token is required as well.
    expect(why).toMatch(/pairing token/i);
  });
});

describe('Nuxt is ranked by what the project config says, not by a static list', () => {
  it('leads with the dev-server restart for Nuxt, where HMR does not register a new plugin', () => {
    const why = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [3000],
      port: 4400,
      framework: 'nuxt',
    });
    expect(why).toMatch(/Nuxt/);
    expect(why).toMatch(/HMR|hot module|restart/i);
    // Ranked, not merely mentioned: the Nuxt sentence comes before the port-mismatch talk.
    const nuxtAt = why.search(/Nuxt/);
    const portAt = why.search(/port matches|different daemon/i);
    expect(nuxtAt).toBeGreaterThanOrEqual(0);
    expect(-1 === portAt || nuxtAt < portAt).toBe(true);
  });

  it('says nothing about Nuxt for a Vite project', () => {
    const why = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [3000],
      port: 4400,
      framework: 'vite',
    });
    expect(why).not.toMatch(/Nuxt/);
  });
});

describe('a wired project is never told to run init', () => {
  const cases = [
    { listening: [], previouslyConnected: false },
    { listening: [3000], previouslyConnected: false },
    { listening: [3000], previouslyConnected: true },
    { listening: [], previouslyConnected: true },
  ] as const;

  for (const c of cases) {
    it(`listening=[${c.listening.join(',')}] previouslyConnected=${String(c.previouslyConnected)}`, () => {
      const why = diagnoseNoSession({
        everConnected: false,
        initialized: true,
        listening: c.listening,
        previouslyConnected: c.previouslyConnected,
        port: 4400,
      });
      expect(why).not.toContain('reticle init');
    });
  }
});

describe('a listener that IS found is reported as found', () => {
  it('names the port and says the missing piece is a loaded page, not a server', () => {
    const why = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [3000],
      port: 4400,
    });
    expect(why).toContain('3000');
    expect(why).toMatch(/LOADED|open the app|reticle open/i);
    // The three states need three actions. "No server" must not be implied when one was found.
    expect(why).not.toMatch(/nothing is listening/i);
  });
});
