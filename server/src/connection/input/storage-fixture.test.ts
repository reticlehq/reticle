import { describe, expect, it } from 'vitest';
import { fixturePortFor, seedFromStorageState } from './storage-fixture.js';
import type { RealInputProvider } from './real-input.js';

/**
 * The port that turns a driven browser into somewhere a suite can start from.
 *
 * A realm offers `applyFixture` only when something can honour it, and on the web that is not a
 * property of the realm — it is a property of the connection. Reading the wire settled it: there is
 * a `storage_read` command and no storage WRITE, and a page cannot write an httpOnly cookie from
 * inside itself, which is the entire point of httpOnly. So an ATTACHED session can never restore
 * auth however much is added to the SDK, and a DRIVEN page can, because a browser context sits
 * behind it.
 *
 * This is therefore the one place that decides whether a fixture is available at all, and the answer
 * is "no" far more often than it is "yes" — which is correct, and merely slower.
 */

const URL = 'http://localhost:4312/';

function provider(over: Partial<RealInputProvider> = {}): RealInputProvider {
  return {
    isAvailableFor: () => Promise.resolve(true),
    perform: () => Promise.resolve({ ok: true }),
    ...over,
  } as unknown as RealInputProvider;
}

describe('when a fixture port is available at all', () => {
  it('is not offered by a provider that cannot do storage', async () => {
    // The common case, and the one that must NOT quietly produce a half-working fixture: a provider
    // with no storage support omits the methods entirely, exactly as it does for screenshots.
    expect(await fixturePortFor(provider(), URL)).toBeUndefined();
  });

  it('is not offered when no driven page matches this session', async () => {
    // A provider that COULD do storage, for a page it is not driving. Answering here would restore
    // state into whatever page it happened to find, which is worse than not answering.
    const p = provider({
      isAvailableFor: () => Promise.resolve(false),
      storageState: () => Promise.resolve({ cookies: [] }),
      applyStorageState: () => Promise.resolve(true),
    });
    expect(await fixturePortFor(p, URL)).toBeUndefined();
  });

  it('is offered when the provider drives this page and can read its storage', async () => {
    const p = provider({
      storageState: () => Promise.resolve({ cookies: [{ name: 'sid' }] }),
      applyStorageState: () => Promise.resolve(true),
    });
    expect(await fixturePortFor(p, URL)).toBeDefined();
  });
});

describe('what the port carries', () => {
  const working = (): { p: RealInputProvider; applied: unknown[] } => {
    const applied: unknown[] = [];
    const p = provider({
      storageState: () => Promise.resolve({ cookies: [{ name: 'sid', value: 'abc' }] }),
      applyStorageState: (_url: string, state: unknown) => {
        applied.push(state);
        return Promise.resolve(true);
      },
    });
    return { p, applied };
  };

  it('captures the browser context state verbatim, because only the browser can read it back', async () => {
    const { p } = working();
    const port = await fixturePortFor(p, URL);
    expect(await port?.capture()).toEqual({ cookies: [{ name: 'sid', value: 'abc' }] });
  });

  it('puts it back unchanged', async () => {
    const { p, applied } = working();
    const port = await fixturePortFor(p, URL);
    await port?.apply({ cookies: [{ name: 'sid', value: 'abc' }] });
    expect(applied).toEqual([{ cookies: [{ name: 'sid', value: 'abc' }] }]);
  });

  it('THROWS when the browser refused to restore, rather than reporting a fixture that is not there', async () => {
    // Silence here is the whole failure mode: a suite that believes it is signed in and is not
    // produces fifty flows failing for a reason none of them names.
    const p = provider({
      storageState: () => Promise.resolve({ cookies: [] }),
      applyStorageState: () => Promise.resolve(false),
    });
    const port = await fixturePortFor(p, URL);
    await expect(port?.apply({ cookies: [] })).rejects.toThrow(/restore|driven|page/i);
  });
});

/**
 * Turning what a browser context saved into what a lease can be booted with.
 *
 * The boot path already existed and I had written down that it did not — `SeedStorage` seeds
 * cookies, localStorage and sessionStorage into an isolated context BEFORE the first navigation,
 * which is exactly and only when a fixture can work. So the gap was never the plumbing; it was that
 * nothing translated between the shape a browser hands back and the shape a lease takes.
 *
 * The two do not line up, and the mismatch matters. Playwright's state is per-ORIGIN, and a lease is
 * booted at one URL: seeding another origin's localStorage into this page would write keys that
 * belong to a site this run never visits. And `storageState()` does not capture sessionStorage at
 * all, so a fixture cannot promise it — a suite relying on a sessionStorage flag would get a
 * silently empty one, which is the quiet half-restore this whole path avoids.
 */
describe('booting a lease from state a browser saved', () => {
  const state = {
    cookies: [{ name: 'sid', value: 'abc', domain: 'localhost', path: '/' }],
    origins: [
      { origin: 'http://localhost:4312', localStorage: [{ name: 'token', value: 'xyz' }] },
      { origin: 'https://elsewhere.test', localStorage: [{ name: 'other', value: 'nope' }] },
    ],
  };

  it('carries the cookies, which are what auth usually is', () => {
    expect(seedFromStorageState(state, URL)?.cookies).toEqual(state.cookies);
  });

  it('carries only THIS origin’s local storage', () => {
    // Seeding another origin's keys into this page writes for a site the run never visits.
    expect(seedFromStorageState(state, URL)?.local).toEqual({ token: 'xyz' });
  });

  it('promises no sessionStorage, because a browser context state does not carry it', () => {
    // Absent, not empty-and-claimed. A suite relying on a flag it was never given should find
    // nothing rather than a silently empty object that looks restored.
    expect(seedFromStorageState(state, URL)?.session).toBeUndefined();
  });

  it('is nothing at all when the saved state holds nothing for this origin', () => {
    const elsewhere = { cookies: [], origins: [state.origins[1]] };
    expect(seedFromStorageState(elsewhere, URL)).toBeUndefined();
  });

  it('is nothing when handed something that is not a browser state', () => {
    expect(seedFromStorageState(undefined, URL)).toBeUndefined();
    expect(seedFromStorageState('signed-in', URL)).toBeUndefined();
  });
});
