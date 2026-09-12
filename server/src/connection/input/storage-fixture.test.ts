import { describe, expect, it } from 'vitest';
import { fixturePortFor } from './storage-fixture.js';
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
