/**
 * The first-run tour, drawn over the user's own running app.
 *
 * The CLI prints the same steps at the end of the install; this is the half a person sees the first
 * time their instrumented app loads in a browser. Both read `TOUR_STEPS` from `@reticlehq/core`, so
 * the two surfaces cannot drift into telling different stories about one product.
 *
 * ## Pure by construction
 *
 * Everything here is a function from state to markup. No timers, no document, no storage — those
 * live in `tour.ts`, which mounts this. That split is what lets every slide, the highlight target,
 * the prompt, and the "seen" rule be asserted without a browser, which is where the presenter's own
 * hardest bugs have always hidden.
 */

import { TOUR_STEPS, TOUR_HANDOFF_PROMPT, TourAnchor, type TourStep } from '@reticlehq/core/tour';
import { Z_TOUR } from '../chrome/layers.js';

/** The slide after the last step: the move somebody makes next, ready to paste. */
export const HANDOFF_INDEX = TOUR_STEPS.length;

/** Every slide, including the handoff. */
export const SLIDE_COUNT = TOUR_STEPS.length + 1;

export const TOUR_ATTR = 'data-reticle-tour';
/** Marks the element under test and under the highlight, so a test need not guess a class name. */
export const TOUR_TARGET_ATTR = 'data-reticle-tour-target';

export interface TourSlide {
  readonly index: number;
  readonly title: string;
  readonly body: string;
  readonly why?: string;
  readonly call?: string;
  readonly anchor: TourAnchor;
  /** The handoff slide carries the prompt; every other slide carries none. */
  readonly prompt?: string;
}

const stepSlide = (step: TourStep, index: number): TourSlide => ({
  index,
  title: step.title,
  body: step.say,
  ...(undefined === step.why ? {} : { why: step.why }),
  ...(undefined === step.call ? {} : { call: step.call }),
  anchor: step.anchor ?? TourAnchor.NONE,
});

/**
 * The slides, in order.
 *
 * The handoff is generated rather than written into `TOUR_STEPS`, because it is not a step of the
 * loop — it is what to do once the loop is understood, and putting it in the shared list would make
 * the CLI print a "paste this" slide at somebody who is already in a terminal.
 */
export function tourSlides(): readonly TourSlide[] {
  return [
    ...TOUR_STEPS.map(stepSlide),
    {
      index: HANDOFF_INDEX,
      title: 'Hand it to your agent',
      body: 'That is the whole loop. Paste this to your agent and it will do it against this app.',
      anchor: TourAnchor.NONE,
      prompt: TOUR_HANDOFF_PROMPT,
    },
  ];
}

/** Escape for text interpolated into markup. The prompt and steps are ours, but this is a page. */
export function escapeHtml(text: string): string {
  return text
    .split('&')
    .join('&amp;')
    .split('<')
    .join('&lt;')
    .split('>')
    .join('&gt;')
    .split('"')
    .join('&quot;');
}

/**
 * Which slide comes next, clamped.
 *
 * A separate function because "next" is the one thing a carousel gets wrong in a way nobody notices
 * until the last slide: an unclamped increment leaves an empty panel and a Next button that does
 * nothing, which reads as the tour having broken rather than ended.
 */
export function nextIndex(current: number, delta: number): number {
  const wanted = current + delta;
  if (wanted < 0) return 0;
  if (wanted > SLIDE_COUNT - 1) return SLIDE_COUNT - 1;
  return wanted;
}

export const isLastSlide = (index: number): boolean => index === SLIDE_COUNT - 1;

/** One slide's inner markup. */
export function slideHtml(slide: TourSlide): string {
  const dots = tourSlides()
    .map(
      (s) =>
        `<span class="reticle-tour-dot${s.index === slide.index ? ' is-on' : ''}" aria-hidden="true"></span>`,
    )
    .join('');
  const why =
    undefined === slide.why ? '' : `<p class="reticle-tour-why">${escapeHtml(slide.why)}</p>`;
  const call =
    undefined === slide.call
      ? ''
      : `<code class="reticle-tour-call">${escapeHtml(slide.call)}</code>`;
  const prompt =
    undefined === slide.prompt
      ? ''
      : `<div class="reticle-tour-prompt"><pre ${TOUR_TARGET_ATTR}="prompt" class="reticle-tour-prompt-text">${escapeHtml(slide.prompt)}</pre>` +
        `<button type="button" class="reticle-tour-copy" ${TOUR_TARGET_ATTR}="copy">Copy prompt</button></div>`;
  const back =
    0 === slide.index
      ? ''
      : `<button type="button" class="reticle-tour-back" ${TOUR_TARGET_ATTR}="back">Back</button>`;
  const forward = isLastSlide(slide.index)
    ? `<button type="button" class="reticle-tour-next" ${TOUR_TARGET_ATTR}="done">Done</button>`
    : `<button type="button" class="reticle-tour-next" ${TOUR_TARGET_ATTR}="next">Next</button>`;

  return (
    `<div class="reticle-tour-card" role="dialog" aria-modal="false" aria-label="Reticle tour">` +
    `<button type="button" class="reticle-tour-skip" ${TOUR_TARGET_ATTR}="skip" aria-label="Skip the tour">Skip</button>` +
    `<p class="reticle-tour-step">Step ${String(slide.index + 1)} of ${String(SLIDE_COUNT)}</p>` +
    `<h2 class="reticle-tour-title">${escapeHtml(slide.title)}</h2>` +
    `<p class="reticle-tour-body">${escapeHtml(slide.body)}</p>` +
    why +
    call +
    prompt +
    `<div class="reticle-tour-foot"><div class="reticle-tour-dots">${dots}</div>` +
    `<div class="reticle-tour-nav">${back}${forward}</div></div>` +
    `</div>`
  );
}

/**
 * The stylesheet.
 *
 * Deliberately plain and self-contained: this draws over somebody else's app, so it inherits
 * nothing and sets what it needs. `pointer-events` is explicit on the card because the overlay root
 * turns them off page-wide, and a tour nobody can click is the one failure this cannot ship with.
 */
export const TOUR_CSS = `
[${TOUR_ATTR}]{position:fixed;inset:0;z-index:${String(Z_TOUR)};pointer-events:none;
  font:13px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}
[${TOUR_ATTR}] .reticle-tour-scrim{position:absolute;inset:0;background:rgba(6,8,14,.55);
  backdrop-filter:blur(1.5px);pointer-events:auto;}
/* Ringed slides dim through the ring's own 9999px shadow, which leaves a hole over the thing being
   pointed at. The scrim would cover that hole -- dimming the HUD the slide is ABOUT, and washing
   the page twice (~80% rather than 55%). Cleared, not removed: it is also what swallows clicks
   meant for the app underneath, and a tour that lets you click through is not a tour. */
[${TOUR_ATTR}] .reticle-tour-scrim.is-clear{background:transparent;backdrop-filter:none;}
[${TOUR_ATTR}] .reticle-tour-card{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:min(430px,calc(100vw - 32px));box-sizing:border-box;pointer-events:auto;
  background:#14161d;color:#e8eaf0;border:1px solid #2b303d;border-radius:14px;padding:20px 20px 16px;
  box-shadow:0 24px 60px rgba(0,0,0,.5);}
[${TOUR_ATTR}] .reticle-tour-skip{position:absolute;top:10px;right:12px;background:none;border:0;
  color:#8a93a6;font:inherit;font-size:12px;cursor:pointer;padding:4px 6px;border-radius:6px;}
[${TOUR_ATTR}] .reticle-tour-skip:hover{color:#e8eaf0;background:rgba(255,255,255,.06);}
[${TOUR_ATTR}] .reticle-tour-step{margin:0 0 6px;font-size:11px;letter-spacing:.06em;
  text-transform:uppercase;color:#7f8798;}
[${TOUR_ATTR}] .reticle-tour-title{margin:0 0 8px;font-size:18px;line-height:1.25;font-weight:650;
  color:#f2f4f8;}
[${TOUR_ATTR}] .reticle-tour-body{margin:0 0 10px;color:#c9cedb;}
[${TOUR_ATTR}] .reticle-tour-why{margin:0 0 10px;color:#8a93a6;font-size:12.5px;}
[${TOUR_ATTR}] .reticle-tour-call{display:block;margin:0 0 12px;padding:8px 10px;border-radius:8px;
  background:#0c0e14;border:1px solid #232834;color:#9fb6ff;
  font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
  white-space:pre-wrap;overflow-wrap:anywhere;}
[${TOUR_ATTR}] .reticle-tour-prompt{margin:0 0 12px;}
[${TOUR_ATTR}] .reticle-tour-prompt-text{width:100%;box-sizing:border-box;margin:0;
  white-space:pre-wrap;overflow-wrap:anywhere;max-height:190px;overflow-y:auto;
  background:#0c0e14;border:1px solid #232834;border-radius:8px;color:#c9cedb;padding:9px 10px;
  font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;}
[${TOUR_ATTR}] .reticle-tour-copy{margin-top:8px;width:100%;padding:9px 12px;border-radius:8px;
  border:0;background:#6366f1;color:#fff;font:inherit;font-weight:600;cursor:pointer;}
[${TOUR_ATTR}] .reticle-tour-copy:hover{filter:brightness(1.08);}
[${TOUR_ATTR}] .reticle-tour-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;}
[${TOUR_ATTR}] .reticle-tour-dots{display:flex;gap:6px;}
[${TOUR_ATTR}] .reticle-tour-dot{width:6px;height:6px;border-radius:50%;background:#333a49;}
[${TOUR_ATTR}] .reticle-tour-dot.is-on{background:#6366f1;}
[${TOUR_ATTR}] .reticle-tour-nav{display:flex;gap:8px;}
[${TOUR_ATTR}] .reticle-tour-back,[${TOUR_ATTR}] .reticle-tour-next{padding:8px 14px;border-radius:8px;
  font:inherit;font-weight:600;cursor:pointer;border:1px solid #2b303d;background:transparent;color:#c9cedb;}
[${TOUR_ATTR}] .reticle-tour-next{background:#6366f1;border-color:#6366f1;color:#fff;}
[${TOUR_ATTR}] .reticle-tour-next:hover{filter:brightness(1.08);}
[${TOUR_ATTR}] .reticle-tour-back:hover{background:rgba(255,255,255,.06);color:#e8eaf0;}
[${TOUR_ATTR}] .reticle-tour-ring{position:absolute;border-radius:14px;pointer-events:none;
  box-shadow:0 0 0 3px #6366f1,0 0 0 9999px rgba(6,8,14,.55);transition:all .25s ease;}
@media (prefers-reduced-motion:reduce){
  [${TOUR_ATTR}] .reticle-tour-ring{transition:none;}
}
`;
