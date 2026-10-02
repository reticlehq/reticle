import { describe, expect, it } from 'vitest';
import { RETICLE_URL_PARAM } from '@reticlehq/core';
import { mountTour } from './tour.js';

/**
 * The onboarding tour, blocking the agent it was shipped alongside.
 *
 * The scrim takes `pointer-events:auto` ON PURPOSE -- tour-view.ts says "a tour that lets you click
 * through is not a tour", and that is right for a human reading it. It is wrong for a page Reticle
 * opened for ITSELF, and there the cost is total: every native click and hover lands on the scrim
 * instead of the app.
 *
 * MEASURED against next-smoke. `drive-launch-test` and `spec-runner-test` both failed on a hover
 * that reported `dispatched: true, inputMode: "real"` and produced no `mouseenter` at all. Playwright
 * named the cause outright once asked directly:
 *
 *   <div class="reticle-tour-scrim is-clear"></div> from <div data-reticle-tour="">…</div>
 *   subtree intercepts pointer events
 *
 * `mountTour` already declines while `isDriving()`, which is the right rule read at the wrong
 * moment: it is evaluated once at page load, when the presenter is still IDLE because the agent has
 * not acted yet. The agent acts a second later, into a scrim.
 *
 * So a page carrying Reticle's own session stamp -- one a lease or a drive opened -- never mounts it
 * at all. That page has no human on it to onboard.
 */
/**
 * Storage that WORKS and says nothing has been seen.
 *
 * The first version of this passed `undefined` and the two stamp cases went green before the fix
 * existed: an unavailable storage already counts as "already seen", so `mountTour` declined for a
 * reason that had nothing to do with the stamp. A test that cannot fail is worse than no test, and
 * this family is the one that catches false greens.
 */
const freshStorage = () => ({ getItem: () => null, setItem: () => undefined });

const harness = (search: string, driving = false) => {
  const doc = document.implementation.createHTMLDocument('t');
  const handle = mountTour({
    document: doc,
    storage: freshStorage(),
    projectId: 'p1',
    isDriving: () => driving,
    copy: () => true,
    search,
  });
  return { doc, handle };
};

describe('a page Reticle opened for itself', () => {
  it('never mounts the tour for a drive, so nothing can swallow it', () => {
    const { doc, handle } = harness(`?${RETICLE_URL_PARAM.OPENED}=1`);
    expect(handle).toBeUndefined();
    expect(doc.querySelector('[data-reticle-tour]')).toBeNull();
  });

  it('never mounts it for a lease either', () => {
    const { doc, handle } = harness(`?${RETICLE_URL_PARAM.SESSION}=lease-7`);
    expect(handle).toBeUndefined();
    expect(doc.querySelector('[data-reticle-tour]')).toBeNull();
  });

  it('declines on a project stamp too — both halves mark a page Reticle opened', () => {
    expect(harness(`?${RETICLE_URL_PARAM.PROJECT}=acme-9f3c`).handle).toBeUndefined();
  });

  it('steps aside when a drive starts after the page loaded, and does not count that as seen', async () => {
    const doc = document.implementation.createHTMLDocument('t');
    const overlay = doc.createElement('div');
    overlay.setAttribute('data-reticle-overlay', '');
    overlay.setAttribute('data-reticle-mode', 'idle');
    doc.body.appendChild(overlay);
    let driving = false;
    let seen = false;
    const handle = mountTour({
      document: doc,
      storage: {
        getItem: () => null,
        setItem: () => {
          seen = true;
        },
      },
      projectId: 'p1',
      isDriving: () => driving,
      search: '',
    });
    expect(handle).toBeDefined();
    expect(doc.querySelector('[data-reticle-tour]')).not.toBeNull();
    driving = true;
    overlay.setAttribute('data-reticle-mode', 'acting');
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(doc.querySelector('[data-reticle-tour]')).toBeNull();
    expect(seen).toBe(false);
  });

  it('still shows the tour on a plain dev load, which is the load it exists for', () => {
    // No stamp, nobody driving, storage unavailable counts as seen -- so pass storage that says no.
    const doc = document.implementation.createHTMLDocument('t');
    const handle = mountTour({
      document: doc,
      storage: freshStorage(),
      projectId: 'p1',
      isDriving: () => false,
      copy: () => true,
      search: '?utm_source=blog',
    });
    expect(handle).toBeDefined();
    expect(doc.querySelector('[data-reticle-tour]')).not.toBeNull();
    handle?.destroy();
  });
});
