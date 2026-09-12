/**
 * Turning a driven browser into somewhere a suite can start from.
 *
 * A realm offers `applyFixture` only when something can honour it, and on the web that is not a
 * property of the realm — it is a property of the CONNECTION. The wire settles it: there is a
 * `storage_read` command and no storage write, and a page cannot write an httpOnly cookie from
 * inside itself, which is the entire point of httpOnly. So an ATTACHED session can never restore
 * auth however much is added to the SDK; a DRIVEN page can, because a browser context sits behind
 * it and that context owns the cookie jar.
 *
 * This is therefore the one place that decides whether a web fixture exists at all, and the answer
 * is "no" far more often than "yes" — which is correct, and merely slower: every flow runs from cold.
 */

import type { RealInputProvider } from './real-input.js';

/**
 * What this hands back: save and restore, and nothing else.
 *
 * Declared here rather than imported from the realm that consumes it, deliberately. The realm owns
 * the interface it DEPENDS on and this file owns the thing that provides one; neither needs to know
 * the other exists, and they meet at the composition root where TypeScript checks the shapes agree.
 * Importing the realm's port here would make a provider depend on its consumer, which is the
 * inversion backwards — and the reach guard says so before anybody has to argue about it.
 */
export interface StorageFixturePort {
  capture(): Promise<unknown>;
  apply(payload: unknown): Promise<void>;
}

/**
 * A port for this session, or nothing.
 *
 * Nothing when the provider cannot do storage at all, and nothing when it is not driving THIS page.
 * The second case matters as much as the first: a provider that answered for a page it does not
 * drive would restore state into whatever page it happened to find, which is worse than refusing.
 */
export async function fixturePortFor(
  provider: RealInputProvider,
  sessionUrl: string,
): Promise<StorageFixturePort | undefined> {
  // Not destructured: a method pulled off its object loses `this`, and these are real methods on a
  // provider that holds a browser.
  if (provider.storageState === undefined || provider.applyStorageState === undefined) {
    return undefined;
  }
  if (!(await provider.isAvailableFor(sessionUrl))) return undefined;
  return {
    /** Verbatim, and opaque: only the browser that wrote this can read it back. */
    capture: () => provider.storageState?.(sessionUrl) ?? Promise.resolve(undefined),
    apply: async (payload: unknown): Promise<void> => {
      const restored = await provider.applyStorageState?.(sessionUrl, payload);
      /*
       * A refusal is thrown, never swallowed.
       *
       * Silence is the whole failure mode here: a suite that believes it is signed in and is not
       * produces fifty flows failing for a reason none of them names, and the first one anybody
       * reads blames the feature it was testing.
       */
      // `undefined` cannot happen — the method was checked above — but it is the same answer as
      // false either way: nothing confirmed the state went back.
      if (true !== restored) {
        throw new Error(
          `could not restore state into ${sessionUrl}: no driven page matched this session when ` +
            'the fixture was applied. A fixture needs a driven browser (`reticle drive` / ' +
            'RETICLE_CDP_URL); an attached tab cannot have a cookie jar written into it from ' +
            'inside the page.',
        );
      }
    },
  };
}
