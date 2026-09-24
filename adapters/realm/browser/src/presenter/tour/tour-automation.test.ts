/**
 * A page under automation has nobody to onboard, so the tour never mounts on one.
 *
 * Field reports, all of them from drivers OUTSIDE Reticle: "Reticle tour scrim blocks Playwright
 * pointer click on Overview row in fresh browser context", "Three browser runs stalled before
 * Playwright debug exposed reticle-tour-scrim pointer interception", "Test real pointer interactions
 * without an invisible testing overlay blocking the app".
 *
 * Two guards already existed and neither covers this. `isDriving()` is false at page load, because
 * the agent has not acted yet - the file says so itself. `openedByReticle()` reads a URL stamp
 * Reticle puts on pages IT opens, and an agent that launches its own Playwright context and calls
 * `page.goto` never carries one.
 *
 * `navigator.webdriver` is the question being asked, said directly: true under Playwright, CDP, the
 * browser pool's leased tabs and CI; false in the dev browser a person actually has open, which is
 * the only case a tour is for. The same discriminator `effectivePaceMs` already uses for the same
 * reason - one of these browsers has a human in front of it and the other does not.
 */
import { describe, expect, it } from 'vitest';
import { mountTour } from './tour.js';

/** Real storage: a tour with none is treated as already seen, which would pass every case here. */
const freshStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string): string | null => map.get(k) ?? null,
    setItem: (k: string, v: string): void => void map.set(k, v),
  };
};

const deps = (webdriver: boolean | undefined) => ({
  document,
  storage: freshStorage(),
  projectId: 'proj',
  isDriving: () => false,
  search: '',
  navigator: undefined === webdriver ? {} : ({ webdriver } as Navigator),
});

describe('the tour and automated browsers', () => {
  it('declines to mount when the browser is driven by automation', () => {
    expect(mountTour(deps(true))).toBeUndefined();
    expect(document.querySelector('.reticle-tour-scrim')).toBeNull();
  });

  it('still mounts for a person, which is who it is for', () => {
    const handle = mountTour(deps(false));
    expect(handle).toBeDefined();
    handle?.destroy();
  });

  /* A caller that supplies no navigator keeps the old behaviour rather than losing its tour. */
  it('mounts when nothing says the browser is automated', () => {
    const handle = mountTour(deps(undefined));
    expect(handle).toBeDefined();
    handle?.destroy();
  });
});
