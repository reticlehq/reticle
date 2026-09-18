/**
 * The first-run tour: what it says, who it points at, and when it refuses to appear.
 *
 * The CLI half of this reached nobody twice — first as a pointer somebody had to choose to follow,
 * then behind an `isTTY` check that is `undefined` through every pipe. Both were invisible because
 * nothing asserted that the tour was actually PUT IN FRONT of anyone. These do.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { TOUR_STEPS, TOUR_HUD_STEPS, TOUR_HANDOFF_PROMPTS, TourAnchor } from '@reticlehq/core/tour';
import {
  COPIED_LABEL,
  COPY_LABEL,
  COPY_MANUAL_LABEL,
  HANDOFF_INDEX,
  SLIDE_COUNT,
  escapeHtml,
  isLastSlide,
  nextIndex,
  slideHtml,
  tourSlides,
  withInlineCode,
  TOUR_CSS,
} from './tour-view.js';
import { mountTour, tourAlreadySeen, tourSeenKey, type TourStorage } from './tour.js';
import { at } from '@/test-support/array-at.js';

/**
 * Where a slide with this anchor SITS, which is not where its step sits.
 *
 * The browser interleaves four HUD slides the CLI never prints, so an index into `TOUR_STEPS` stopped
 * being an index into the carousel. Every test that clicked Next that many times was then landing on
 * a different slide than it named, and asserting about it confidently.
 */
const slideIndexWithAnchor = (anchor: TourAnchor): number =>
  tourSlides().findIndex((s) => anchor === s.anchor);

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
  /*
   * The carousel shows a SUBSET of the shared steps, and the order rule still binds the subset.
   *
   * It used to show all of them. The browser tour is now six cards read standing up, so only the
   * first shared step is drawn and the three that teach the verify loop stay in the CLI tutorial.
   * What must not happen is the two surfaces putting the same steps in a DIFFERENT order, which is
   * how a support answer stops matching what anybody did — so this checks relative order, and says
   * nothing about how many were chosen.
   */
  it('shows the shared steps it does show in the shared order', () => {
    const shown = tourSlides().map((s) => s.title);
    const sharedShown = TOUR_STEPS.map((s) => s.title).filter((t) => shown.includes(t));
    expect(sharedShown.length, 'the carousel shows no shared step at all').toBeGreaterThan(0);
    const positions = sharedShown.map((t) => shown.indexOf(t));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  // The six somebody actually sees, named. A slide quietly appearing or vanishing is the kind of
  // change that is invisible in a diff of prose and obvious to the person reading the carousel.
  it('is six cards: connected, the four panel controls, then the prompts', () => {
    expect(tourSlides().map((s) => s.title)).toEqual([
      'Yayyy! It is connected',
      'Activity Panel',
      'Annotate',
      "What's the impact?",
      'Make it yours',
      'Get Started',
    ]);
  });

  it('ends at a verdict, then hands over — looking is not verifying', () => {
    const last = at(TOUR_STEPS, -1);
    expect(last?.id).toBe('verdict');
    expect(at(tourSlides(), -1)?.prompts).toEqual(TOUR_HANDOFF_PROMPTS);
  });

  // The handoff is generated here rather than kept in TOUR_STEPS, so the CLI does not print a
  // "paste this" slide at somebody who is already in a terminal.
  it('does not put the handoff into the shared steps', () => {
    expect(TOUR_STEPS.some((s) => s.say.includes('Paste this'))).toBe(false);
    expect(SLIDE_COUNT).toBe(1 + TOUR_HUD_STEPS.length + 1);
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
    const last = at(tourSlides(), -1);
    expect(last).toBeDefined();
    const html = slideHtml(last as NonNullable<typeof last>);
    expect(html).toContain('"done"');
    expect(html).not.toContain('"next"');
  });

  it('carries every prompt, each with its own way to copy it', () => {
    const last = at(tourSlides(), -1);
    const html = slideHtml(last as NonNullable<typeof last>);
    for (const prompt of TOUR_HANDOFF_PROMPTS) {
      expect(html).toContain(escapeHtml(prompt.text));
      expect(html).toContain(escapeHtml(prompt.label));
    }
    // One button per prompt. A single button on a slide carrying three of them can only copy one,
    // and nothing on screen would say which.
    expect(html.split('"copy"').length - 1).toBe(TOUR_HANDOFF_PROMPTS.length);
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
    const handle = mountTour({
      ...freshDeps(),
      copy: (t) => {
        copied.push(t);
        return true;
      },
    });
    for (let i = 0; i < SLIDE_COUNT; i += 1) click('next');
    click('copy');
    expect(copied).toEqual([TOUR_HANDOFF_PROMPTS[0]?.text]);
    handle?.destroy();
  });

  // A ring floating over nothing tells somebody to look where there is nothing to see. The HUD is
  // genuinely absent when the panel is disabled, so the highlight has to check rather than assume.
  it('draws no highlight when the HUD it points at is not on the page', () => {
    const anchored = slideIndexWithAnchor(TourAnchor.HUD);
    expect(anchored).toBeGreaterThanOrEqual(0);
    const handle = mountTour(freshDeps());
    expect(document.querySelector('[data-reticle-tour] .reticle-tour-ring')).toBeNull();
    handle?.destroy();
  });

  /*
   * The slide that pointed at the app is no longer in the carousel.
   *
   * "Look, without pixels" was the only APP-anchored slide, and the six-card tour does not draw it.
   * The two tests that drove it are gone with it rather than being kept alive against a slide that
   * cannot be reached; `anchorBox` still knows how to outline a content region, and nothing in the
   * browser asks it to today. See the note on that branch in `tour.ts`.
   */

  // The carousel no longer prints a code block, so this guards the SHARED data the CLI
  // tutorial still prints: a step whose example is only a comment teaches nothing runnable.
  it('gives every shared step a call that is a call, not a comment standing in for one', () => {
    const placeholders = TOUR_STEPS.filter(
      (s) => undefined !== s.call && s.call.trimStart().startsWith('//'),
    );
    expect(placeholders.map((s) => s.title)).toEqual([]);
  });

  /**
   * The spotlight has to actually light something.
   *
   * The ring dims the page with its own `0 0 0 9999px` shadow, which leaves a HOLE where the ringed
   * element is — that is the whole trick. The scrim is a separate full-viewport element, so it went
   * on covering that hole: the HUD the slide points AT was dimmed by the same 55% wash as the app
   * behind it, and the page took the wash twice over (~80%). Found in a screenshot, where the ringed
   * slides are visibly darker than the ones with no ring and the HUD icons inside the ring are
   * barely legible.
   *
   * A `jsdom` document has no layout, so the real `getBoundingClientRect` reports 0 and the ring
   * declines. Stubbed to give the HUD a box, which is what a browser would report.
   */
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

  it('clears the scrim on the slide that rings the HUD, so the spotlight is a real hole', () => {
    withHud(() => {
      const handle = mountTour(freshDeps());
      const ringed = slideIndexWithAnchor(TourAnchor.HUD);
      for (let i = 0; i < ringed; i += 1) click('next');

      expect(document.querySelector('[data-reticle-tour] .reticle-tour-ring')).not.toBeNull();
      const scrim = document.querySelector('[data-reticle-tour] .reticle-tour-scrim');
      expect(scrim?.className).toContain('is-clear');
      handle?.destroy();
    });
  });

  // The negative control. With no ring there is no hole, so the scrim is the only thing dimming the
  // page and it must stay opaque — clearing it unconditionally would leave the tour on a bright app.
  it('keeps the scrim opaque on a slide that rings nothing', () => {
    withHud(() => {
      const handle = mountTour(freshDeps());
      const plain = slideIndexWithAnchor(TourAnchor.NONE);
      expect(plain).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < plain; i += 1) click('next');

      expect(document.querySelector('[data-reticle-tour] .reticle-tour-ring')).toBeNull();
      const scrim = document.querySelector('[data-reticle-tour] .reticle-tour-scrim');
      expect(scrim?.className ?? '').not.toContain('is-clear');
      handle?.destroy();
    });
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
    'reticle-tour-step',
    'reticle-tour-code',
    'reticle-tour-try',
    'reticle-tour-prompt-label',
    'reticle-tour-prompt-text',
  ];

  /*
   * The card no longer renders a code block, so the rule that stopped one being cut in half is
   * gone with it. The lesson survives next door: the prompt text on the last slide wraps for the
   * same reason, and the prompt-wrapping test below is what now holds it.
   */

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

/**
 * The HUD walkthrough, and the four defects it was reported with.
 *
 * All five found the same way the last round of tour defects were: by opening it on a running app
 * and reading it as a user, rather than by asserting things about it. Every one of them passed
 * every DOM assertion that existed at the time.
 */
describe('the tour explains the panel it just put on the page', () => {
  afterEach(() => {
    for (const el of document.querySelectorAll('[data-reticle-tour]')) el.remove();
    for (const el of document.querySelectorAll('[data-reticle-hud]')) el.remove();
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

  /** A HUD with the four controls the walkthrough points at, each with a box a browser would report. */
  const withHudControls = (run: () => void): void => {
    const hud = document.createElement('div');
    hud.setAttribute('data-reticle-hud', '');
    hud.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 40 }) as DOMRect;
    const controls = [
      'data-reticle-chat-toggle',
      'data-reticle-annotate-btn',
      'data-reticle-report-btn',
      'data-reticle-settings-btn',
    ];
    controls.forEach((attr, i) => {
      const button = document.createElement('button');
      button.setAttribute(attr, '');
      button.getBoundingClientRect = () =>
        ({ left: 20 + i * 30, top: 25, width: 24, height: 24 }) as DOMRect;
      hud.appendChild(button);
    });
    document.body.appendChild(hud);
    try {
      run();
    } finally {
      hud.remove();
    }
  };

  /*
   * The panel arrived unexplained.
   *
   * The tour rang the HUD twice and said nothing about any of the four buttons in it, so they sat in
   * the corner of somebody's own app as decoration. A control nobody has been told the purpose of is
   * a control nobody presses.
   */
  it('gives every HUD control a slide of its own', () => {
    const anchors = tourSlides().map((s) => s.anchor);
    for (const anchor of [
      TourAnchor.HUD_CHAT,
      TourAnchor.HUD_ANNOTATE,
      TourAnchor.HUD_IMPACT,
      TourAnchor.HUD_SETTINGS,
    ]) {
      expect(anchors, `no slide points at ${anchor}`).toContain(anchor);
    }
  });

  it('rings the real control each of those slides is about', () => {
    withHudControls(() => {
      for (const anchor of [
        TourAnchor.HUD_CHAT,
        TourAnchor.HUD_ANNOTATE,
        TourAnchor.HUD_IMPACT,
        TourAnchor.HUD_SETTINGS,
      ]) {
        const at = slideIndexWithAnchor(anchor);
        const handle = mountTour(freshDeps());
        for (let i = 0; i < at; i += 1) click('next');
        const ring = document.querySelector('[data-reticle-tour] .reticle-tour-ring');
        expect(ring, `${anchor} drew no ring`).not.toBeNull();
        // 24px control, 6px of clearance either side.
        expect(ring?.getAttribute('style')).toContain('width: 36px');
        handle?.destroy();
      }
    });
  });

  /*
   * "Open it" over a scrim that eats the click.
   *
   * The scrim keeps `pointer-events:auto` even when cleared for a spotlight, so a slide inviting
   * somebody to press a HUD button was asking for an action and then silently refusing it. The
   * conclusion a person draws from a button that does nothing is about the product.
   */
  it('leaves a real hole over a control it invites you to press', () => {
    withHudControls(() => {
      const handle = mountTour(freshDeps());
      const at = slideIndexWithAnchor(TourAnchor.HUD_IMPACT);
      for (let i = 0; i < at; i += 1) click('next');

      expect(document.querySelector('[data-reticle-tour] .reticle-tour-scrim')).toBeNull();
      const blockers = document.querySelectorAll('[data-reticle-tour] .reticle-tour-blocker');
      expect(blockers.length).toBeGreaterThan(0);
      handle?.destroy();
    });
  });

  // The negative control: a slide that only says "look at this" keeps the scrim, because nothing is
  // being offered and letting clicks through would just be a tour you can click past.
  it('keeps the scrim on a slide that only points', () => {
    withHudControls(() => {
      const handle = mountTour(freshDeps());
      const at = slideIndexWithAnchor(TourAnchor.HUD);
      for (let i = 0; i < at; i += 1) click('next');
      expect(document.querySelector('[data-reticle-tour] .reticle-tour-scrim')).not.toBeNull();
      expect(document.querySelectorAll('[data-reticle-tour] .reticle-tour-blocker').length).toBe(0);
      handle?.destroy();
    });
  });
});

/**
 * The card sat UNDER the thing that dims the page.
 *
 * Reported from a screenshot: on a slide ringing the HUD, the card looked washed out and behind the
 * page rather than on top of it. The ring is appended after the card and neither carried a z-index,
 * so the ring painted above — and the ring's dimming is a 9999px shadow, which therefore fell across
 * the card too. It rendered, it was readable enough to pass every assertion about its text, and it
 * looked broken.
 */
describe('the card is never dimmed by the thing doing the dimming', () => {
  const zIndexOf = (selector: string): number => {
    const block = TOUR_CSS.split(selector)[1] ?? '';
    const found = /z-index:(\d+)/.exec(block.split('}')[0] ?? '');
    return Number(found?.[1] ?? Number.NaN);
  };

  it('stacks the card above the ring, and the ring above the scrim', () => {
    const card = zIndexOf('.reticle-tour-card{');
    const ring = zIndexOf('.reticle-tour-ring{');
    const scrim = zIndexOf('.reticle-tour-scrim{');
    expect(Number.isNaN(card), 'the card declares no z-index').toBe(false);
    expect(Number.isNaN(ring), 'the ring declares no z-index').toBe(false);
    expect(card).toBeGreaterThan(ring);
    expect(ring).toBeGreaterThan(scrim);
  });
});

/**
 * Copy said nothing at all.
 *
 * `copy` was called for its side effect and the button never changed, so the only way to learn
 * whether anything had reached the clipboard was to go and paste somewhere else. The case where
 * nothing could POSSIBLY have been copied — no `navigator.clipboard`, which is every insecure
 * origin — was indistinguishable from success.
 */
describe('the copy button says what happened', () => {
  afterEach(() => {
    for (const el of document.querySelectorAll('[data-reticle-tour]')) el.remove();
  });

  const deps = (over: Partial<Parameters<typeof mountTour>[0]> = {}) => ({
    document,
    storage: memoryStorage(),
    projectId: `p${String(Math.random())}`,
    isDriving: () => false,
    ...over,
  });
  const toHandoff = (): void => {
    for (let i = 0; i < SLIDE_COUNT; i += 1) {
      document
        .querySelector<HTMLElement>('[data-reticle-tour] [data-reticle-tour-target="next"]')
        ?.click();
    }
  };
  const copyButtons = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('[data-reticle-tour] .reticle-tour-copy'),
  ];

  it('confirms on the button that was pressed, and only that one', () => {
    const handle = mountTour(deps({ copy: () => true }));
    toHandoff();
    const buttons = copyButtons();
    expect(buttons.length).toBe(TOUR_HANDOFF_PROMPTS.length);
    buttons[1]?.click();
    expect(buttons[1]?.textContent).toBe(COPIED_LABEL);
    expect(buttons[0]?.textContent).toBe(COPY_LABEL);
    handle?.destroy();
  });

  it('copies the prompt belonging to the button, not always the first', () => {
    const copied: string[] = [];
    const handle = mountTour(
      deps({
        copy: (t) => {
          copied.push(t);
          return true;
        },
      }),
    );
    toHandoff();
    copyButtons()[2]?.click();
    expect(copied).toEqual([TOUR_HANDOFF_PROMPTS[2]?.text]);
    handle?.destroy();
  });

  /*
   * No clipboard is an ANSWER, not a silence.
   *
   * An insecure origin has no `navigator.clipboard` at all. Selecting the text turns the dead end
   * into one keystroke, and the label names the keystroke rather than leaving somebody to work out
   * why their paste was empty.
   */
  it('selects the text and says so when there is no clipboard to write to', () => {
    const selected: string[] = [];
    const handle = mountTour(
      deps({
        copy: () => false,
        select: (el) => void selected.push(el.textContent ?? ''),
      }),
    );
    toHandoff();
    const button = copyButtons()[0];
    button?.click();
    expect(button?.textContent).toBe(COPY_MANUAL_LABEL);
    expect(selected).toEqual([TOUR_HANDOFF_PROMPTS[0]?.text]);
    handle?.destroy();
  });

  // A host that injects no `copy` at all is the same failure, and must reach the same answer rather
  // than a button that silently does nothing forever.
  it('treats a missing copy capability as a failure to copy', () => {
    const handle = mountTour(deps());
    toHandoff();
    const button = copyButtons()[0];
    button?.click();
    expect(button?.textContent).toBe(COPY_MANUAL_LABEL);
    handle?.destroy();
  });
});

/**
 * Escape did nothing, and neither did the arrow keys.
 *
 * Escape is the first thing anybody tries on something covering their screen. A carousel that can
 * only be moved by hitting a small button is one people leave open and work around.
 */
describe('the tour answers the keys people actually press', () => {
  afterEach(() => {
    for (const el of document.querySelectorAll('[data-reticle-tour]')) el.remove();
  });

  const freshDeps = () => ({
    document,
    storage: memoryStorage(),
    projectId: `p${String(Math.random())}`,
    isDriving: () => false,
  });
  const press = (key: string): void => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  };
  const stepLine = (): string =>
    document.querySelector('[data-reticle-tour] .reticle-tour-step')?.textContent ?? '';

  it('moves with the arrow keys and closes on Escape', () => {
    const handle = mountTour(freshDeps());
    expect(stepLine()).toContain('Step 1');
    press('ArrowRight');
    expect(stepLine()).toContain('Step 2');
    press('ArrowLeft');
    expect(stepLine()).toContain('Step 1');
    press('Escape');
    expect(handle?.isOpen()).toBe(false);
    expect(document.querySelector('[data-reticle-tour]')).toBeNull();
  });

  // A tour that is gone from the page while still eating arrow keys is worse than one that never
  // listened: the keys stop reaching the app, and there is nothing on screen to explain why.
  it('stops listening once it is closed', () => {
    const handle = mountTour(freshDeps());
    handle?.destroy();
    let reached = 0;
    const count = (): void => {
      reached += 1;
    };
    document.addEventListener('keydown', count);
    press('ArrowRight');
    document.removeEventListener('keydown', count);
    expect(reached).toBe(1);
    expect(document.querySelector('[data-reticle-tour]')).toBeNull();
  });
});

/**
 * Prose written for a terminal, rendered in a card.
 *
 * The steps are shared with the CLI, where `like this` is the ordinary way to mark a call inside a
 * sentence. The card printed the character. The verdict slide — the most important one in the tour —
 * read "Only `reticle_act_and_wait` and `reticle_assert` produce a verdict" with the backticks on
 * screen, which is what unrendered markup looks like. Found in a screenshot.
 */
describe('a call named inside a sentence is rendered as one', () => {
  it('turns a backtick span into code rather than printing the character', () => {
    const html = withInlineCode('Only `reticle_assert` produces a verdict');
    expect(html).toContain('<code class="reticle-tour-code">reticle_assert</code>');
    expect(html).not.toContain('`');
  });

  it('escapes before it renders, so a span cannot carry markup', () => {
    expect(withInlineCode('`</div><img onerror=x>`')).not.toContain('<img');
  });

  it('leaves every slide free of stray backticks once rendered', () => {
    for (const slide of tourSlides()) {
      const body = slideHtml(slide).split('reticle-tour-call')[0] ?? '';
      expect(body, `slide ${String(slide.index + 1)} prints a backtick`).not.toContain('`');
    }
  });
});

/**
 * "That panel is Reticle" — and the ring was around the toolbar.
 *
 * The first slide names a PANEL and the highlight covered only `[data-reticle-hud]`, the little
 * toolbar strip. The chat panel the word "panel" actually describes is a sibling element, outside
 * it, so a reader followed the ring and landed on something the sentence was not about. The same
 * mismatch as the three the last round fixed: the ring, the prose and the call have to agree.
 *
 * Found in a screenshot of a real app, which is the only place the two boxes are ever side by side.
 */
describe('the HUD highlight covers the whole of what the slide calls the panel', () => {
  afterEach(() => {
    for (const el of document.querySelectorAll('[data-reticle-tour]')) el.remove();
    for (const el of document.querySelectorAll('[data-reticle-hud],[data-reticle-chat-panel]'))
      el.remove();
  });

  const freshDeps = () => ({
    document,
    storage: memoryStorage(),
    projectId: `p${String(Math.random())}`,
    isDriving: () => false,
  });

  const place = (attr: string, box: { l: number; t: number; w: number; h: number }): void => {
    const el = document.createElement('div');
    el.setAttribute(attr, '');
    el.getBoundingClientRect = () =>
      ({ left: box.l, top: box.t, width: box.w, height: box.h }) as DOMRect;
    document.body.appendChild(el);
  };
  const ringBox = (): Record<string, string> => {
    const style = document
      .querySelector('[data-reticle-tour] .reticle-tour-ring')
      ?.getAttribute('style');
    return Object.fromEntries(
      (style ?? '')
        .split(';')
        .filter((p) => p.includes(':'))
        .map((p) => p.split(':').map((x) => x.trim()) as [string, string]),
    );
  };

  it('rings the toolbar and the open chat panel as one box', () => {
    // A real arrangement: the panel sits above the toolbar and is wider than it.
    place('data-reticle-hud', { l: 661, t: 494, w: 340, h: 44 });
    place('data-reticle-chat-panel', { l: 620, t: 200, w: 380, h: 280 });
    const handle = mountTour(freshDeps());

    // 6px of clearance, as every spotlight gets. Union is left 620, top 200, right 1001, bottom 538.
    expect(ringBox()).toMatchObject({
      left: '614px',
      top: '194px',
      width: '393px',
      height: '350px',
    });
    handle?.destroy();
  });

  /*
   * A CLOSED panel must not be ringed.
   *
   * It is `display:none` when collapsed, so it reports a zero box — and a union that took it anyway
   * would stretch the ring to the top-left corner of the viewport and point at nothing. Measured on
   * the live panel rather than assumed.
   */
  it('ignores the chat panel while it is closed', () => {
    place('data-reticle-hud', { l: 661, t: 494, w: 340, h: 44 });
    place('data-reticle-chat-panel', { l: 0, t: 0, w: 0, h: 0 });
    const handle = mountTour(freshDeps());
    expect(ringBox()).toMatchObject({
      left: '655px',
      top: '488px',
      width: '352px',
      height: '56px',
    });
    handle?.destroy();
  });
});
