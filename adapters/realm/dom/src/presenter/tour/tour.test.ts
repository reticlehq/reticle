/**
 * The first-run tour: what it says, who it points at, and when it refuses to appear.
 *
 * The CLI half of this reached nobody twice — first as a pointer somebody had to choose to follow,
 * then behind an `isTTY` check that is `undefined` through every pipe. Both were invisible because
 * nothing asserted that the tour was actually PUT IN FRONT of anyone. These do.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { TOUR_STEPS, TOUR_HANDOFF_PROMPT, TourAnchor } from '@reticlehq/core/tour';
import {
  HANDOFF_INDEX,
  SLIDE_COUNT,
  escapeHtml,
  isLastSlide,
  nextIndex,
  slideHtml,
  tourSlides,
  TOUR_CSS,
} from './tour-view.js';
import { mountTour, tourAlreadySeen, tourSeenKey, type TourStorage } from './tour.js';

function memoryStorage(
  seed: Record<string, string> = {},
): TourStorage & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe('the tour is the same tour the CLI prints', () => {
  it('renders every shared step, in the shared order', () => {
    const ids = tourSlides()
      .slice(0, TOUR_STEPS.length)
      .map((s) => s.title);
    expect(ids).toEqual(TOUR_STEPS.map((s) => s.title));
  });

  it('ends at a verdict, then hands over — looking is not verifying', () => {
    const last = TOUR_STEPS.at(-1);
    expect(last?.id).toBe('verdict');
    expect(tourSlides().at(-1)?.prompt).toBe(TOUR_HANDOFF_PROMPT);
  });

  // The handoff is generated here rather than kept in TOUR_STEPS, so the CLI does not print a
  // "paste this" slide at somebody who is already in a terminal.
  it('does not put the handoff into the shared steps', () => {
    expect(TOUR_STEPS.some((s) => s.say.includes('Paste this'))).toBe(false);
    expect(SLIDE_COUNT).toBe(TOUR_STEPS.length + 1);
  });
});

describe('the carousel cannot walk off either end', () => {
  it('clamps at the first slide', () => {
    expect(nextIndex(0, -1)).toBe(0);
  });

  // An unclamped increment leaves an empty panel and a Next button that does nothing, which reads
  // as the tour having broken rather than ended.
  it('clamps at the last slide', () => {
    expect(nextIndex(SLIDE_COUNT - 1, 1)).toBe(SLIDE_COUNT - 1);
    expect(isLastSlide(HANDOFF_INDEX)).toBe(true);
  });
});

describe('what a slide puts on the page', () => {
  it('offers Done rather than Next on the last slide', () => {
    const last = tourSlides().at(-1);
    expect(last).toBeDefined();
    const html = slideHtml(last as NonNullable<typeof last>);
    expect(html).toContain('"done"');
    expect(html).not.toContain('"next"');
  });

  it('carries the prompt and a way to copy it', () => {
    const last = tourSlides().at(-1);
    const html = slideHtml(last as NonNullable<typeof last>);
    expect(html).toContain('Copy prompt');
    expect(html).toContain(escapeHtml(TOUR_HANDOFF_PROMPT).slice(0, 40));
  });

  it('has no Back on the first slide, and Back after it', () => {
    const [first, second] = tourSlides();
    expect(slideHtml(first as NonNullable<typeof first>)).not.toContain('"back"');
    expect(slideHtml(second as NonNullable<typeof second>)).toContain('"back"');
  });

  // It draws over somebody else's app. Their copy must not be able to close our markup.
  it('escapes text rather than interpolating it raw', () => {
    expect(escapeHtml('</div><img onerror=x>')).not.toContain('<img');
    expect(escapeHtml('a & b')).toContain('&amp;');
  });

  it('always says where in the sequence somebody is', () => {
    for (const slide of tourSlides()) {
      expect(slideHtml(slide)).toContain(
        `Step ${String(slide.index + 1)} of ${String(SLIDE_COUNT)}`,
      );
    }
  });
});

describe('when the tour refuses to appear', () => {
  const deps = (over: Partial<Parameters<typeof mountTour>[0]> = {}) => ({
    document,
    storage: memoryStorage(),
    projectId: 'proj',
    isDriving: () => false,
    ...over,
  });

  it('shows once, and not again', () => {
    const storage = memoryStorage();
    const first = mountTour(deps({ storage }));
    expect(first?.isOpen()).toBe(true);
    first?.destroy();
    expect(mountTour(deps({ storage }))).toBeUndefined();
  });

  // Reticle's whole job while a tool is acting is to let it act. A modal that eats clicks would
  // break the product in order to explain it.
  it('stays away while an agent is driving', () => {
    expect(mountTour(deps({ isDriving: () => true }))).toBeUndefined();
  });

  /*
   * A thrown accessor counts as "already seen".
   *
   * A private window or blocked site data makes every read throw. Treating that as "not seen"
   * would show the tour on every single load, and the failure mode of showing it too often is
   * worse than the failure mode of never showing it.
   */
  it('treats unreadable storage as seen rather than showing it forever', () => {
    const hostile: TourStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
    };
    expect(tourAlreadySeen(hostile, 'proj')).toBe(true);
    expect(mountTour(deps({ storage: hostile }))).toBeUndefined();
  });

  it('treats no storage at all as seen', () => {
    expect(tourAlreadySeen(undefined, 'proj')).toBe(true);
  });

  // Two apps on one machine each get their own tour; the key is per project, not global.
  it('keys the memory per project', () => {
    expect(tourSeenKey('a')).not.toBe(tourSeenKey('b'));
    const storage = memoryStorage();
    mountTour(deps({ storage, projectId: 'a' }))?.destroy();
    const second = mountTour(deps({ storage, projectId: 'b' }));
    expect(second?.isOpen()).toBe(true);
    second?.destroy();
  });
});

describe('driving the carousel on a real document', () => {
  afterEach(() => {
    for (const el of document.querySelectorAll('[data-reticle-tour]')) el.remove();
  });

  const freshDeps = () => ({
    document,
    storage: memoryStorage(),
    projectId: `p${String(Math.random())}`,
    isDriving: () => false,
  });

  const click = (what: string): void => {
    document
      .querySelector<HTMLElement>(`[data-reticle-tour] [data-reticle-tour-target="${what}"]`)
      ?.click();
  };
  const stepLine = (): string =>
    document.querySelector('[data-reticle-tour] .reticle-tour-step')?.textContent ?? '';

  it('advances, goes back, and closes on Done', () => {
    const handle = mountTour(freshDeps());
    expect(stepLine()).toContain('Step 1');
    click('next');
    expect(stepLine()).toContain('Step 2');
    click('back');
    expect(stepLine()).toContain('Step 1');
    for (let i = 0; i < SLIDE_COUNT; i += 1) click('next');
    expect(stepLine()).toContain(`Step ${String(SLIDE_COUNT)}`);
    click('done');
    expect(handle?.isOpen()).toBe(false);
    expect(document.querySelector('[data-reticle-tour]')).toBeNull();
  });

  it('copies the prompt from the last slide', () => {
    const copied: string[] = [];
    const handle = mountTour({ ...freshDeps(), copy: (t) => void copied.push(t) });
    for (let i = 0; i < SLIDE_COUNT; i += 1) click('next');
    click('copy');
    expect(copied).toEqual([TOUR_HANDOFF_PROMPT]);
    handle?.destroy();
  });

  // A ring floating over nothing tells somebody to look where there is nothing to see. The HUD is
  // genuinely absent when the panel is disabled, so the highlight has to check rather than assume.
  it('draws no highlight when the HUD it points at is not on the page', () => {
    const anchored = TOUR_STEPS.findIndex((s) => TourAnchor.HUD === s.anchor);
    expect(anchored).toBeGreaterThanOrEqual(0);
    const handle = mountTour(freshDeps());
    expect(document.querySelector('[data-reticle-tour] .reticle-tour-ring')).toBeNull();
    handle?.destroy();
  });
});

/**
 * Every text element in the card names its OWN colour.
 *
 * `.reticle-tour-title` did not, and inherited from the card. That is fine in isolation and wrong
 * on a page: an inherited colour loses to any direct element selector in the host app, so a scaffold
 * with a plain `h2 { color: … }` rule turned the heading to `rgb(8, 6, 13)` — black text on a
 * near-black card, on every slide. It rendered, it passed every DOM assertion, and it was unreadable.
 * Only a screenshot found it.
 */
describe('the card cannot be restyled by the page it is drawn over', () => {
  const TEXT_CLASSES = [
    'reticle-tour-title',
    'reticle-tour-body',
    'reticle-tour-why',
    'reticle-tour-step',
    'reticle-tour-call',
    'reticle-tour-prompt-text',
  ];

  it('sets an explicit colour on every text class, rather than inheriting one', () => {
    const missing = TEXT_CLASSES.filter((cls) => {
      // Character classes rather than escapes: a literal dot, brace and close-brace, with nothing
      // for a reader (or eslint) to second-guess.
      const rule = new RegExp(`[.]${cls}[{][^}]*[}]`).exec(TOUR_CSS.replace(/\s*\n\s*/g, ''));
      return null === rule || !rule[0].includes('color:');
    });
    expect(
      missing,
      'these classes inherit their colour, which any `h2 {color}` in the host app overrides',
    ).toEqual([]);
  });

  // The prompt is the one thing on the last slide somebody has to READ before pasting. A fixed
  // height silently cut the final sentence — "Do not tell me it works until Reticle says
  // verified: yes" — which is the sentence the whole product is about.
  it('lets the prompt size to its content instead of clipping it', () => {
    const rule = /\.reticle-tour-prompt-text\{[^}]*\}/.exec(TOUR_CSS.replace(/\s*\n\s*/g, ''));
    expect(rule?.[0]).not.toMatch(/(^|;)height:\d/);
    expect(rule?.[0]).toContain('pre-wrap');
  });
});
