/**
 * Mounting the first-run tour. The half that touches a document.
 *
 * `tour-view.ts` decides what every slide says and which element it points at, as pure functions.
 * This puts them on a page, listens for clicks, and remembers that somebody has seen it. Split that
 * way because the presenter's hardest bugs have always been in what gets RENDERED and when — and a
 * real document is exactly the thing that hides those.
 *
 * ## Shown once, and only where it can help
 *
 * Once per project, keyed in `localStorage`. A tour that reappears on every reload is not
 * onboarding, it is a popup, and the second time somebody sees one they stop reading it.
 *
 * It also never shows while an agent is driving. Reticle's whole job in that moment is to let a
 * tool act on the page, and a modal that eats clicks would break the product to explain it.
 */

import {
  COPIED_LABEL,
  COPY_FLASH_MS,
  COPY_LABEL,
  COPY_MANUAL_LABEL,
  TOUR_ATTR,
  TOUR_CSS,
  TOUR_PROMPT_ATTR,
  TOUR_TARGET_ATTR,
  holeRects,
  isInteractive,
  type TourRect,
  isLastSlide,
  nextIndex,
  slideHtml,
  tourSlides,
} from './tour-view.js';
import { TourAnchor } from '@reticlehq/core/tour';
import { RETICLE_URL_PARAM } from '@reticlehq/core';

/** Where "they have seen it" is remembered. Per project, so a second app still gets its tour. */
export const TOUR_SEEN_KEY_PREFIX = 'reticle.tour.seen.';

/**
 * Where the app's own content lives, in preference order.
 *
 * `<main>` first because an app that has one has said where its content is. Then the two mount
 * nodes that between them cover most of what `create-vite` and friends scaffold. `document.body`
 * is deliberately NOT a fallback: it includes the HUD and every fixed overlay, so a ring around it
 * is a ring around the whole viewport, which points at nothing by pointing at everything.
 */
const APP_SELECTORS = ['main', '#root', '#app'] as const;

/**
 * Everything the first slide means when it says "that panel".
 *
 * `[data-reticle-hud]` alone is the toolbar strip. The chat panel — the thing a reader actually
 * looks at when they read the word panel — is a SIBLING of it, so ringing only the toolbar sent
 * somebody to a row of icons while the sentence beside it talked about something else.
 *
 * Unioned rather than swapped, because either one can be the whole of what is on screen: the chat
 * panel is `display:none` while it is collapsed, and the toolbar is always there. Taking the union
 * of whichever are VISIBLE is the only version that is right in both states.
 */
const HUD_PARTS = ['[data-reticle-hud]', '[data-reticle-chat-panel]'] as const;

/**
 * The smallest box containing every one of these that is actually on screen, or nothing.
 *
 * A zero box means `display:none` — measured on the live panel, not assumed — and including one
 * would drag a corner of the ring to 0,0 and point it at empty page. So an element that reports no
 * area is not part of the union rather than being a union with the origin.
 */
function unionOfVisible(doc: Document, selectors: readonly string[]): TourRect | undefined {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const selector of selectors) {
    const box = doc.querySelector(selector)?.getBoundingClientRect();
    if (undefined === box || box.width <= 0 || box.height <= 0) continue;
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.left + box.width);
    bottom = Math.max(bottom, box.top + box.height);
  }
  if (right === Number.NEGATIVE_INFINITY) return undefined;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * The HUD control each anchor points at.
 *
 * Reticle's own toolbar, so these are attributes this repository writes rather than markup we are
 * guessing at — the same licence that lets a slide ring the panel at all. Kept as a map rather than
 * a switch so the set of pointable controls is one readable list; a slide naming an anchor that is
 * not here rings nothing, which is the same refusal as a HUD that is switched off.
 */
const HUD_CONTROL_SELECTORS: Readonly<Partial<Record<TourAnchor, string>>> = {
  [TourAnchor.HUD_CHAT]: '[data-reticle-chat-toggle]',
  [TourAnchor.HUD_ANNOTATE]: '[data-reticle-annotate-btn]',
  [TourAnchor.HUD_IMPACT]: '[data-reticle-report-btn]',
  [TourAnchor.HUD_SETTINGS]: '[data-reticle-settings-btn]',
};

/**
 * The box to ring for a slide's anchor, or undefined when there is nothing honest to ring.
 *
 * Every anchor declines the same way and for the same reason: the HUD is genuinely absent when the
 * panel is disabled, a control is absent when its toolbar is not rendered, and an app with none of
 * the selectors above is an app whose content region we would be guessing at. A tour that guesses
 * points somebody at the wrong thing with full confidence.
 */
function anchorBox(doc: Document, anchor: TourAnchor): TourRect | undefined {
  if (TourAnchor.HUD === anchor) return unionOfVisible(doc, HUD_PARTS);
  const control = HUD_CONTROL_SELECTORS[anchor];
  if (undefined !== control) {
    const box = doc.querySelector(control)?.getBoundingClientRect();
    return undefined === box ? undefined : box;
  }
  // NOT REACHED by the current carousel. "Look, without pixels" was the only APP-anchored slide and
  // the six-card tour does not draw it, so nothing asks for a content region today. Kept rather than
  // deleted because the shared step still declares the anchor and the rule this encodes was learned
  // the hard way: a region is OUTLINED, never spotlit, because cutting a hole the size of the app
  // removes the dimming entirely. Re-add a slide with this anchor and it works again; delete this
  // and that lesson has to be relearned by looking at it.
  if (TourAnchor.APP !== anchor) return undefined;
  for (const selector of APP_SELECTORS) {
    const found = doc.querySelector(selector);
    if (null === found) continue;
    const box = found.getBoundingClientRect();
    if (box.width > 0) return box;
  }
  return undefined;
}

export const tourSeenKey = (projectId: string): string => `${TOUR_SEEN_KEY_PREFIX}${projectId}`;

/** The storage this needs. Injected, because `localStorage` throws outright in some embeddings. */
export interface TourStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface TourDeps {
  readonly document: Document;
  readonly storage: TourStorage | undefined;
  readonly projectId: string;
  /** True while a tool is acting. The tour stays away rather than eating the clicks. */
  readonly isDriving: () => boolean;
  /**
   * `window.location.search` of the page being mounted into.
   *
   * Reticle stamps a session or project id onto every URL it opens for itself — a lease, or a
   * drive. A page carrying one has no human on it, so there is nobody to onboard and the scrim can
   * only get in the way of the agent. Optional: a caller that cannot supply it gets the old
   * behaviour rather than a crash.
   */
  readonly search?: string;
  /**
   * The navigator of the page being mounted into, for the one question `webdriver` answers.
   *
   * Optional: a caller that cannot supply one keeps its tour rather than losing it to a guard that
   * could not read the thing it guards on.
   */
  readonly navigator?: { readonly webdriver?: boolean };
  /**
   * Copying is a capability, not a guarantee — an insecure origin has no clipboard.
   *
   * It reports whether the text actually landed. A `void` call makes a page with a working clipboard
   * and a page with none the same event as far as this file can tell, so the button says the same
   * thing about both by saying nothing. `false` is what lets the tour fall back to selecting the text
   * so it can still be copied by hand.
   */
  readonly copy?: (text: string) => Promise<boolean> | boolean;
  /** Selecting the prompt is the fallback when there is no clipboard. Injected for the same reason. */
  readonly select?: (element: Element) => void;
}

export interface TourHandle {
  readonly destroy: () => void;
  /** Visible right now. Exposed for the tests that assert it went away. */
  readonly isOpen: () => boolean;
}

/**
 * Did Reticle open this page for its own use?
 *
 * Read off the URL rather than asked of the presenter, because the presenter cannot answer it yet
 * at mount time — which is the whole defect this closes.
 */
export function openedByReticle(search: string | undefined): boolean {
  if (search === undefined || '' === search) return false;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return (
    params.has(RETICLE_URL_PARAM.OPENED) ||
    params.has(RETICLE_URL_PARAM.SESSION) ||
    params.has(RETICLE_URL_PARAM.PROJECT)
  );
}

/**
 * Has this person already been shown the tour here?
 *
 * Any storage failure counts as "yes". A private window, blocked site data or a thrown accessor
 * must not turn into a tour on every single load — the failure mode of showing it too often is
 * worse than the failure mode of not showing it at all.
 */
export function tourAlreadySeen(storage: TourStorage | undefined, projectId: string): boolean {
  if (undefined === storage) return true;
  try {
    return null !== storage.getItem(tourSeenKey(projectId));
  } catch {
    return true;
  }
}

function markSeen(storage: TourStorage | undefined, projectId: string): void {
  try {
    storage?.setItem(tourSeenKey(projectId), '1');
  } catch {
    /* A tour that cannot be remembered is still worth having shown once. */
  }
}

/**
 * Show the tour, unless it has been seen or an agent is mid-drive.
 *
 * Returns `undefined` when it declines, so a caller cannot accidentally treat "not shown" as a
 * live handle and then try to tear down something that was never mounted.
 */
export function mountTour(deps: TourDeps): TourHandle | undefined {
  if (deps.isDriving()) return undefined;
  /*
   * `isDriving()` is the right rule read one moment too early.
   *
   * It is evaluated at page load, when the presenter is still IDLE because the agent has not acted
   * yet -- the agent acts a second later, into a scrim that takes `pointer-events: auto` on purpose.
   * MEASURED on next-smoke: a hover reporting `dispatched: true, inputMode: "real"` produced no
   * `mouseenter` at all, and Playwright named the scrim as the interceptor when asked directly.
   *
   * The URL stamp is known at mount and cannot race: Reticle puts it on every page it opens for
   * itself. A tour is for the person who ran `npm run dev`, never for a page nobody is looking at.
   */
  if (openedByReticle(deps.search)) return undefined;
  /*
   * A browser under automation has nobody to onboard.
   *
   * The two guards above do not cover it. `isDriving()` reads false at page load by construction,
   * and `openedByReticle` reads a stamp Reticle puts on pages IT opens - an agent that launches its
   * own Playwright context and calls `page.goto` carries none. Reported from the field three times
   * over, always the same way: the scrim takes `pointer-events: auto`, the driver's click lands on
   * it instead of the app, and the run stalls until somebody attaches a debugger to find out why.
   *
   * `navigator.webdriver` is that question said directly, and the same discriminator
   * `effectivePaceMs` already uses for the same reason: one of these browsers has a person in front
   * of it and the other does not.
   */
  if (true === deps.navigator?.webdriver) return undefined;
  if (tourAlreadySeen(deps.storage, deps.projectId)) return undefined;

  const doc = deps.document;
  const style = doc.createElement('style');
  style.setAttribute(TOUR_ATTR, '');
  style.textContent = TOUR_CSS;
  doc.head.appendChild(style);

  const root = doc.createElement('div');
  root.setAttribute(TOUR_ATTR, '');

  const slides = tourSlides();
  let index = 0;
  let open = true;

  // Set once the key listener exists. Closing must detach it however it was closed — via Escape,
  // Skip, Done or `destroy` — and a tour that is gone from the page while still eating arrow keys
  // is worse than one that never listened.
  let detachKeys: () => void = () => undefined;

  let stopWatch: () => void = () => undefined;

  const remove = (): void => {
    if (!open) return;
    open = false;
    detachKeys();
    stopWatch();
    root.remove();
    style.remove();
  };

  const close = (): void => {
    if (!open) return;
    markSeen(deps.storage, deps.projectId);
    remove();
  };

  /**
   * A drive that starts after mount.
   *
   * `isDriving()` is false at load, because the agent has not acted yet. The scrim is already up
   * when the first command lands. Taking it down here is the other half of declining at mount.
   * It is not "seen": the person never finished it, and the next plain load should still show it.
   */
  const yieldToDrive = (): void => {
    if (!deps.isDriving()) return;
    remove();
  };

  const draw = (): void => {
    const slide = slides[index];
    if (undefined === slide) return;
    root.innerHTML = `<div class="reticle-tour-scrim"></div>${slideHtml(slide)}`;
    // The highlight is drawn only when the thing it points at is actually on the page. A ring
    // floating over nothing is worse than no ring: it tells somebody to look where there is
    // nothing to see, and the HUD is genuinely absent when the panel is disabled.
    if (TourAnchor.NONE !== slide.anchor) {
      const box = anchorBox(doc, slide.anchor);
      if (undefined !== box && box.width > 0) {
        // A REGION is outlined; a TARGET is spotlit. The app is the whole content area, so cutting
        // a hole for it removes the dimming entirely — the card ends up competing with a fully lit
        // page and the ring edges sit at the margins pointing at nothing. Measured by looking at it.
        const region = TourAnchor.APP === slide.anchor;
        const ring = doc.createElement('div');
        ring.className = region ? 'reticle-tour-ring is-region' : 'reticle-tour-ring';
        // Inset for a region, outset for a target: an outline reads as "all of this" when it sits
        // just inside the thing, and a spotlight needs clearance around what it lights.
        const pad = region ? -2 : 6;
        ring.style.left = `${String(Math.round(box.left - pad))}px`;
        ring.style.top = `${String(Math.round(box.top - pad))}px`;
        ring.style.width = `${String(Math.round(box.width + pad * 2))}px`;
        ring.style.height = `${String(Math.round(box.height + pad * 2))}px`;
        root.appendChild(ring);
        // The spotlight dims the page itself and leaves a hole where the target is. Leaving the
        // scrim opaque fills that hole back in, so the one element the slide points at ends up
        // dimmed like everything else — and the page takes the wash twice. Only for a spotlight: an
        // outlined region keeps its dimming, which is the entire difference between the two.
        if (!region) root.querySelector('.reticle-tour-scrim')?.classList.add('is-clear');
        // An invitation to press it needs the press to actually arrive, and the rest of the page
        // still has to be held: a cleared scrim now blocks nothing at all, so on an interactive
        // slide it is replaced with four rects around the control. Everything stays blocked except
        // the one thing being offered. The ring pulses so the page agrees with the card.
        if (isInteractive(slide)) {
          ring.classList.add('is-live');
          root.querySelector('.reticle-tour-scrim')?.remove();
          const view = doc.defaultView;
          for (const rect of holeRects(
            {
              left: box.left - pad,
              top: box.top - pad,
              width: box.width + pad * 2,
              height: box.height + pad * 2,
            },
            view?.innerWidth ?? doc.documentElement.clientWidth,
            view?.innerHeight ?? doc.documentElement.clientHeight,
          )) {
            const blocker = doc.createElement('div');
            blocker.className = 'reticle-tour-blocker';
            blocker.style.left = `${String(Math.round(rect.left))}px`;
            blocker.style.top = `${String(Math.round(rect.top))}px`;
            blocker.style.width = `${String(Math.round(rect.width))}px`;
            blocker.style.height = `${String(Math.round(rect.height))}px`;
            root.appendChild(blocker);
          }
        }
      }
    }
  };

  /**
   * Copy one prompt, and SAY what happened.
   *
   * The button reports the outcome on itself rather than somewhere else on the card, because that
   * is where the person is looking: they just pressed it. Three outcomes, three labels — copied,
   * could-not-copy-so-the-text-is-selected, and back to normal once the flash expires.
   */
  const copyPrompt = (button: Element): void => {
    const slide = slides[index];
    const which = Number(button.getAttribute(TOUR_PROMPT_ATTR));
    const prompt = slide?.prompts?.[which];
    if (undefined === prompt) return;

    const flash = (label: string, mark: string): void => {
      button.textContent = label;
      button.classList.add(mark);
      doc.defaultView?.setTimeout(() => {
        button.textContent = COPY_LABEL;
        button.classList.remove(mark);
      }, COPY_FLASH_MS);
    };
    const settle = (copied: boolean): void => {
      if (copied) {
        flash(COPIED_LABEL, 'is-done');
        return;
      }
      // No clipboard. Selecting the text turns a dead end into one keystroke, and the label says
      // which keystroke rather than leaving somebody to work out why nothing was pasted.
      const text = root.querySelector(
        `.reticle-tour-prompt[${TOUR_PROMPT_ATTR}="${String(which)}"] .reticle-tour-prompt-text`,
      );
      if (null !== text) deps.select?.(text);
      flash(COPY_MANUAL_LABEL, 'is-manual');
    };

    const result = deps.copy?.(prompt.text);
    if (undefined === result) {
      settle(false);
      return;
    }
    if ('boolean' === typeof result) {
      settle(result);
      return;
    }
    void result.then(settle).catch(() => {
      settle(false);
    });
  };

  root.addEventListener('click', (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const hit = target.closest(`[${TOUR_TARGET_ATTR}]`);
    if (null === hit) return;
    const what = hit.getAttribute(TOUR_TARGET_ATTR);
    if (null === what) return;
    event.preventDefault();
    event.stopPropagation();
    if ('skip' === what || 'done' === what) {
      close();
      return;
    }
    if ('copy' === what) {
      copyPrompt(hit);
      return;
    }
    const moved = nextIndex(index, 'back' === what ? -1 : 1);
    if (moved === index) return;
    index = moved;
    draw();
  });

  /**
   * Arrow keys move, Escape leaves.
   *
   * On the document rather than the overlay, because the overlay never holds focus — on an
   * interactive slide focus belongs to the HUD control being offered, and a listener bound to the
   * card would go deaf at exactly the moment the tour is most in the way. Escape is the one every
   * reader already tries on something covering their screen, and it did nothing.
   */
  const onKey = (event: KeyboardEvent): void => {
    if (!open) return;
    /*
     * An app modal outranks our onboarding.
     *
     * Reported from the field as "Escape does not close a <dialog> opened with showModal()", with
     * the tell in the repro: "after a click inside the dialog it works again" — a click dismisses
     * the tour, and Escape reaches the app from then on. Cancelling the key is what stops the
     * browser's own close request, so while the app has a modal open the tour does not take Escape.
     * It is still dismissable by its own Skip control, and by the click that was closing it anyway.
     */
    if (doc.querySelector('dialog[open]') !== null) return;
    const step = 'ArrowRight' === event.key ? 1 : 'ArrowLeft' === event.key ? -1 : 0;
    if ('Escape' === event.key) {
      event.preventDefault();
      close();
      return;
    }
    if (0 === step) return;
    const moved = nextIndex(index, step);
    if (moved === index) return;
    event.preventDefault();
    index = moved;
    draw();
  };
  doc.addEventListener('keydown', onKey);
  detachKeys = () => {
    doc.removeEventListener('keydown', onKey);
  };

  draw();
  doc.body.appendChild(root);

  const overlay = doc.querySelector('[data-reticle-overlay]');
  if (null !== overlay) {
    const observer = new MutationObserver(yieldToDrive);
    observer.observe(overlay, { attributes: true, attributeFilter: ['data-reticle-mode'] });
    stopWatch = () => observer.disconnect();
    yieldToDrive();
  }

  return {
    destroy: close,
    isOpen: () => open,
  };
}

export { isLastSlide };

/**
 * `localStorage`, or nothing.
 *
 * Reading the property itself throws in a blocked-site-data browser — not the call, the ACCESS — so
 * this is a try around the getter and not around a method. Returning `undefined` makes the tour
 * treat it as already seen, which is the safe direction: never showing it beats showing it on
 * every load.
 */
export function safeLocalStorage(): TourStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
