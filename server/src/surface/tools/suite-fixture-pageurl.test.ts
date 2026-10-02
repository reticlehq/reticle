import { describe, it, expect, vi } from 'vitest';
import { suiteFixturePort, suiteFixtureSeed } from './lease-tools.js';

/**
 * The fixture is looked up by PAGE, and a page is addressed by its URL.
 *
 * `leasableAppUrl` hands back an ORIGIN — `new URL(url).origin`, so no trailing slash and no path.
 * The provider finds a page with `selectPage`, which compares full URLs (minus query and hash), so
 * an origin matches NOTHING: the driven tab is at `http://host:4312/?view=x`, whose stripped form is
 * `http://host:4312/`, and that is not `http://host:4312`.
 *
 * Every "no" in this file is deliberately silent, which is exactly why this had to be pinned by a
 * test: handed an origin, the lookup answered "no page here", the seed came back `undefined`, and a
 * suite that believed it was seeding auth into every leased flow was seeding nothing at all. Nothing
 * threw and nothing went red.
 */
const providerSeeing = (pageUrl: string) => ({
  isAvailableFor: vi.fn((url: string) => Promise.resolve(url === pageUrl)),
  storageState: vi.fn(() =>
    Promise.resolve({ cookies: [{ name: 'sid', value: 'x' }], origins: [] }),
  ),
  applyStorageState: vi.fn(() => Promise.resolve(true)),
  perform: vi.fn(),
});

const PAGE = 'http://localhost:4312/?view=diagnostics';

describe('the suite fixture is looked up by the page URL, not the origin', () => {
  it('finds the port when given the live page URL', async () => {
    const port = await suiteFixturePort(providerSeeing(PAGE), PAGE);
    expect(port).toBeDefined();
  });

  it('captures a seed when given the live page URL', async () => {
    const seed = await suiteFixtureSeed(providerSeeing(PAGE), PAGE);
    expect(seed, 'a driven page with cookies must yield a seed').toBeDefined();
  });

  it('an ORIGIN finds nothing — the shape that made this silently inert', async () => {
    const origin = new URL(PAGE).origin;
    expect(origin).toBe('http://localhost:4312');
    expect(await suiteFixturePort(providerSeeing(PAGE), origin)).toBeUndefined();
  });
});
