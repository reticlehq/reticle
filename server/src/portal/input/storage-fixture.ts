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

import type { SeedStorage } from '@reticlehq/core';
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

/** What a browser context hands back. Per-origin, which is the half that has to be filtered. */
interface SavedContextState {
  cookies?: SeedStorage['cookies'];
  origins?: { origin: string; localStorage?: { name: string; value: string }[] }[];
}

/**
 * Turn state a browser saved into something a lease can be BOOTED with.
 *
 * `SeedStorage` is applied to an isolated context before the first navigation, which is exactly and
 * only when a fixture can work: restoring a cookie jar into a page that has already decided it is
 * signed out is a fixture that appears to work and does nothing.
 *
 * The two shapes do not line up, and the mismatch is the reason this function exists rather than a
 * spread:
 *
 *   - a context state is per-ORIGIN and a lease is booted at one URL, so another origin's
 *     localStorage is dropped. Seeding it would write keys belonging to a site this run never
 *     visits, under the name of a fixture somebody trusts.
 *   - a context state carries no sessionStorage at all, so `session` is left ABSENT rather than set
 *     to an empty object. A suite relying on a flag it was never given should find nothing, not
 *     something that looks restored and is empty.
 *
 * Returns nothing when there is nothing to seed — an empty fixture is not a fixture, and a lease
 * asked to boot with one would pay the isolation cost for no state.
 */
export function seedFromStorageState(state: unknown, pageUrl: string): SeedStorage | undefined {
  if ('object' !== typeof state || null === state) return undefined;
  const saved = state as SavedContextState;
  const local: Record<string, string> = {};
  for (const origin of saved.origins ?? []) {
    if (!pageUrl.startsWith(origin.origin)) continue;
    for (const entry of origin.localStorage ?? []) local[entry.name] = entry.value;
  }
  const cookies = saved.cookies ?? [];
  const hasCookies = Array.isArray(cookies) ? cookies.length > 0 : Object.keys(cookies).length > 0;
  const hasLocal = Object.keys(local).length > 0;
  if (!hasCookies && !hasLocal) return undefined;
  return {
    ...(hasCookies ? { cookies } : {}),
    ...(hasLocal ? { local } : {}),
  };
}
