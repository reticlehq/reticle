/**
 * A transparent scrim that still swallowed every click in the host app.
 *
 * FIELD REPORT, 3.1.0, several users, one of whom removed the plugin from their project: every dev
 * page load drew
 *
 *   <div data-reticle-tour><div class="reticle-tour-scrim is-clear">…
 *
 * over the whole viewport, and nothing in the app underneath could be clicked. A second report has
 * the same element intercepting pointer events for a Playwright driving the same tab.
 *
 * `is-clear` is the SPOTLIGHT state: the ring does the dimming with its own 9999px shadow and the
 * scrim is cleared so the hole the ring cuts is a real one. It was cleared VISUALLY only — it kept
 * `pointer-events:auto` — so the page showed a lit, apparently reachable app and then ate every
 * press on it. An overlay that looks transparent and behaves opaque is the worst of both: a person
 * concludes their own app is broken.
 *
 * The rule this pins: a scrim blocks only while it is visibly blocking. Dimmed wash — blocks, and
 * says so on screen. Cleared for a spotlight — never blocks, because nothing on screen claims it
 * does. The card keeps its own clicks either way, or the tour cannot be dismissed at all.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { TourAnchor } from '@reticlehq/core/tour';
import { mountTour } from './tour.js';
import { tourSlides } from './tour-view.js';

const SCRIM = '[data-reticle-tour] .reticle-tour-scrim';
const CARD = '[data-reticle-tour] .reticle-tour-card';
const NONE = 'none';
const AUTO = 'auto';

const slideIndexWithAnchor = (anchor: TourAnchor): number =>
  tourSlides().findIndex((s) => anchor === s.anchor);

const freshDeps = () => ({
  document,
  storage: { getItem: () => null, setItem: () => undefined },
  projectId: `p${String(Math.random())}`,
  isDriving: () => false,
});

const click = (what: string): void => {
  document
    .querySelector<HTMLElement>(`[data-reticle-tour] [data-reticle-tour-target="${what}"]`)
    ?.click();
};

/** jsdom reports no layout, so the HUD is given the box a browser would report for it. */
const withHud = (run: () => void): void => {
  const hud = document.createElement('div');
  hud.setAttribute('data-reticle-hud', '');
  hud.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 40 }) as DOMRect;
  document.body.appendChild(hud);
  try {
    run();
  } finally {
    hud.remove();
  }
};

const pointerEventsOf = (selector: string): string => {
  const element = document.querySelector(selector);
  if (null === element) return '';
  return window.getComputedStyle(element).pointerEvents;
};

describe('a cleared scrim never takes the app’s clicks', () => {
  afterEach(() => {
    for (const el of document.querySelectorAll('[data-reticle-tour]')) el.remove();
  });

  it('lets a press through on the slide where the page is lit', () => {
    withHud(() => {
      const handle = mountTour(freshDeps());
      const ringed = slideIndexWithAnchor(TourAnchor.HUD);
      for (let i = 0; i < ringed; i += 1) click('next');

      expect(document.querySelector(SCRIM)?.className).toContain('is-clear');
      expect(pointerEventsOf(SCRIM)).toBe(NONE);
      handle?.destroy();
    });
  });

  // The card is the only way out of the tour. Turning the scrim off must not turn it off too.
  it('keeps the card clickable, so the tour can still be dismissed', () => {
    withHud(() => {
      const handle = mountTour(freshDeps());
      for (let i = 0; i < slideIndexWithAnchor(TourAnchor.HUD); i += 1) click('next');

      expect(pointerEventsOf(CARD)).toBe(AUTO);
      handle?.destroy();
    });
  });

  // The negative control. A visible wash IS a modal and blocking is what it looks like it does;
  // making every scrim inert would be a tour you can click straight past.
  it('still blocks while the scrim is the thing dimming the page', () => {
    withHud(() => {
      const handle = mountTour(freshDeps());
      for (let i = 0; i < slideIndexWithAnchor(TourAnchor.NONE); i += 1) click('next');

      expect(document.querySelector(SCRIM)?.className ?? '').not.toContain('is-clear');
      expect(pointerEventsOf(SCRIM)).toBe(AUTO);
      handle?.destroy();
    });
  });
});
