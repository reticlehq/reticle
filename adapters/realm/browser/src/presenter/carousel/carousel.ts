/**
 * The chat panel's top carousel: one card at a time, from whatever the panel has worth saying.
 *
 * It lives INSIDE the log's scroll container, as its first child. That is the whole layout decision:
 * it takes no height from the panel, the toolbar or the log well, and new log rows land below it and
 * push it up and out of view. The log trims and clears its rows by what they are, not by position, so
 * the carousel survives both. Every slide shares one fixed height, so switching never shifts the log.
 *
 * One close control removes it for the tab SESSION and it returns in the next: the cards are offered
 * at every qualifying moment by choice, and "not now" is not "never".
 */

/** Root of the carousel — the one element the log keeps above its rows. */
export const CAROUSEL_ATTR = 'data-reticle-carousel';
/** Each slide, carrying its id. */
export const CAROUSEL_SLIDE_ATTR = 'data-reticle-carousel-slide';
/** Each dot, carrying the index it shows. */
export const CAROUSEL_DOT_ATTR = 'data-reticle-carousel-dot';
/** The close control. */
export const CAROUSEL_CLOSE_ATTR = 'data-reticle-carousel-close';
/** Where "close" is remembered — session storage, so it lasts this tab and no longer. */
export const CAROUSEL_DISMISSED_KEY = 'reticle.carousel.dismissed';

const CLOSE_LABEL = 'Close';

/** How long a slide stays before the next one. Long enough to read two lines and decide. */
export const ROTATE_MS = 6000;

/** One rotation timer per log, so a repaint replaces the timer instead of adding a second one. */
const rotations = new WeakMap<HTMLElement, ReturnType<typeof setInterval>>();

function stopRotation(log: HTMLElement): void {
  const timer = rotations.get(log);
  if (timer !== undefined) clearInterval(timer);
  rotations.delete(log);
}

/** Whether the person asked for less motion. A browser that cannot say reads as no preference. */
function prefersReducedMotion(): boolean {
  try {
    return true === globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Show slide `index`, and mark its dot. The one path dots and rotation both take. */
function show(root: HTMLElement, index: number): void {
  root.setAttribute('data-active', String(index));
  root.querySelectorAll(`[${CAROUSEL_SLIDE_ATTR}]`).forEach((slide, i) => {
    (slide as HTMLElement).hidden = i !== index;
  });
  root.querySelectorAll(`[${CAROUSEL_DOT_ATTR}]`).forEach((dot, i) => {
    dot.setAttribute('aria-current', String(i === index));
  });
}

/** One card: an id for the dot's label, and markup the caller has already escaped. */
export interface Slide {
  id: string;
  html: string;
}

const clampIndex = (index: number, count: number): number =>
  Number.isInteger(index) && index >= 0 && index < count ? index : 0;

/** The carousel's markup, or empty when there is nothing to show. */
export function carouselHtml(slides: readonly Slide[], active: number): string {
  if (0 === slides.length) return '';
  const current = clampIndex(active, slides.length);
  const track = slides
    .map(
      (slide, i) =>
        `<div ${CAROUSEL_SLIDE_ATTR}="${slide.id}" class="reticle-carousel-slide"${i === current ? '' : ' hidden'}>${slide.html}</div>`,
    )
    .join('');
  // One slide needs no dots: there is nowhere to go.
  const dots =
    1 === slides.length
      ? ''
      : `<div class="reticle-carousel-dots">${slides
          .map(
            (slide, i) =>
              `<button type="button" ${CAROUSEL_DOT_ATTR}="${String(i)}" class="reticle-carousel-dot" aria-label="${slide.id}" aria-current="${String(i === current)}"></button>`,
          )
          .join('')}</div>`;
  return `<div ${CAROUSEL_ATTR} class="reticle-carousel" role="region" aria-label="Reticle" data-active="${String(current)}">
      <button type="button" ${CAROUSEL_CLOSE_ATTR} class="reticle-carousel-close" aria-label="${CLOSE_LABEL}" title="${CLOSE_LABEL}">×</button>
      <div class="reticle-carousel-track">${track}</div>
      ${dots}
    </div>`;
}

function dismissed(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    return '1' === storage?.getItem(CAROUSEL_DISMISSED_KEY);
  } catch {
    return false;
  }
}

/**
 * Paint the carousel as the log's first child, replacing any earlier one in place and keeping the
 * slide it was showing. Removes it, and stays removed, once closed in this session.
 */
export function paintCarousel(
  log: HTMLElement,
  slides: readonly Slide[],
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
): void {
  const existing = log.querySelector(`:scope > [${CAROUSEL_ATTR}]`);
  const active = Number(existing?.getAttribute('data-active') ?? '0');
  existing?.remove();
  stopRotation(log);
  if (dismissed(storage)) return;
  const html = carouselHtml(slides, active);
  if ('' === html) return;
  log.insertAdjacentHTML('afterbegin', html);
  const root = log.firstElementChild;
  if (!(root instanceof HTMLElement)) return;

  root.querySelector(`[${CAROUSEL_CLOSE_ATTR}]`)?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      storage?.setItem(CAROUSEL_DISMISSED_KEY, '1');
    } catch {
      /* it closes either way; it simply returns on the next paint */
    }
    stopRotation(log);
    root.remove();
  });
  for (const dot of root.querySelectorAll(`[${CAROUSEL_DOT_ATTR}]`)) {
    dot.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      show(root, Number(dot.getAttribute(CAROUSEL_DOT_ATTR)));
    });
  }
  startRotation(log, root, slides.length);
}

/**
 * Advance a slide every ROTATE_MS while nobody is looking at it.
 *
 * Paused while a pointer is over it or focus is inside it: somebody reading a card, or tabbing to its
 * link, must not have it change under them. Off entirely for one slide, and for anybody who asked the
 * browser for reduced motion.
 */
function startRotation(log: HTMLElement, root: HTMLElement, count: number): void {
  if (count < 2 || prefersReducedMotion()) return;
  let paused = false;
  const pause = (): void => {
    paused = true;
  };
  const resume = (): void => {
    paused = false;
  };
  root.addEventListener('mouseenter', pause);
  root.addEventListener('mouseleave', resume);
  root.addEventListener('focusin', pause);
  root.addEventListener('focusout', resume);
  rotations.set(
    log,
    setInterval(() => {
      // Torn down without a close (the panel unmounted): stop, rather than tick forever.
      if (!root.isConnected) {
        stopRotation(log);
        return;
      }
      if (paused) return;
      show(root, (Number(root.getAttribute('data-active')) + 1) % count);
    }, ROTATE_MS),
  );
}

/**
 * Styles. The track's fixed height is what keeps a slide change from moving the log; the cards
 * inside lose their own frame so the carousel draws one.
 */
export const CAROUSEL_CSS = `
.reticle-carousel{position:relative;margin:8px 10px;padding:10px 12px 8px;border:1px solid var(--reticle-line,#2a2f3a);border-radius:10px;background:var(--reticle-surface-inset,rgba(255,255,255,.03));}
.reticle-carousel-track{height:100px;overflow:hidden;}
.reticle-carousel-slide .reticle-offer,.reticle-carousel-slide .reticle-talk{margin:0;padding:0;border:0;background:none;}
.reticle-carousel-close{position:absolute;top:4px;right:6px;width:20px;height:20px;padding:0;border:0;background:none;color:inherit;opacity:.55;cursor:pointer;font-size:14px;line-height:20px;}
.reticle-carousel-close:hover{opacity:1;}
.reticle-carousel-dots{display:flex;justify-content:center;gap:6px;margin-top:6px;}
.reticle-carousel-dot{width:6px;height:6px;padding:0;border:0;border-radius:999px;background:currentColor;opacity:.3;cursor:pointer;}
.reticle-carousel-dot[aria-current="true"]{opacity:.9;}
`;
