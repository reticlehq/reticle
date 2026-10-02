import { describe, it, expect, vi } from 'vitest';
import { LaunchedRealInputProvider } from './real-input.js';
import { fixturePortFor } from './storage-fixture.js';

/**
 * The provider `reticle drive` uses must be able to save and restore what the subject holds.
 *
 * It could not. `storageState`/`applyStorageState` were implemented on the CDP provider — the one
 * behind `RETICLE_CDP_URL` — and never on this one, which is the provider the ordinary `drive` path
 * builds. `fixturePortFor` refuses at its FIRST check when either method is missing, so it returned
 * `undefined` for every driven session, `suiteFixtureSeed` returned `undefined`, and a suite that
 * read as if it seeded auth into every leased flow seeded nothing.
 *
 * Nothing threw. Every "no" on that path is deliberately silent — a fixture is an optimisation over
 * running cold, and a suite must not die because one failed — which is exactly why the absence
 * survived: it looked identical to "this subject has nothing worth seeding".
 */
const pageStub = (url = 'http://localhost:4312/') => {
  const context = {
    storageState: vi.fn(() => Promise.resolve({ cookies: [{ name: 'sid' }], origins: [] })),
    addCookies: vi.fn(() => Promise.resolve()),
  };
  return {
    url: () => url,
    isClosed: () => false,
    context: () => context,
    evaluate: vi.fn(() => Promise.resolve()),
    _context: context,
  };
};

/** Build the provider with a page already live, the way `navigate()` leaves it. */
const providerWith = (page: unknown): LaunchedRealInputProvider => {
  const p = new LaunchedRealInputProvider({
    driveUrl: 'http://localhost:4312/',
    headless: true,
    launch: () => Promise.resolve({ page, browser: { close: () => Promise.resolve() } }),
  } as never);
  (p as unknown as { '#page': unknown })['#page'] = page;
  return p;
};

describe('the driven provider can save and restore what the subject holds', () => {
  it('declares both halves, so a fixture port can exist for a driven page', () => {
    const p = providerWith(pageStub());
    expect(typeof p.storageState, 'storageState').toBe('function');
    expect(typeof p.applyStorageState, 'applyStorageState').toBe('function');
  });

  it('fixturePortFor refuses when either half is missing — the shape that was silently inert', async () => {
    const halfProvider = {
      isAvailableFor: () => Promise.resolve(true),
      storageState: () => Promise.resolve({}),
      perform: vi.fn(),
    };
    expect(await fixturePortFor(halfProvider as never, 'http://x/')).toBeUndefined();
  });
});
