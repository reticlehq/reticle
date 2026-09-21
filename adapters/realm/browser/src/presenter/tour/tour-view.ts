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

import {
  TOUR_STEPS,
  TOUR_HUD_STEPS,
  TOUR_HANDOFF_PROMPTS,
  TourAnchor,
  type TourPrompt,
  type TourCard,
} from '@reticlehq/core/tour';
import { Z_TOUR } from '@/presenter/chrome/layers.js';

/**
 * The slides, in the order somebody sees them: you are connected, here is the panel, now go.
 *
 * Six, and the shape is deliberate. It opens on the one fact a first run needs (it worked), spends
 * four cards on the panel that has just appeared in the corner of their app, and ends by handing
 * over three things to type. Nothing in between, because a carousel is read standing up.
 *
 * ## The browser shows FEWER shared steps than the terminal, on purpose
 *
 * `core/tour.ts` asks both surfaces to tell one story in one order. They still do, and the order
 * rule is still enforced — but only the first shared step is drawn here. The three that teach the
 * verify loop (look, name the consequence, act and prove) stay in `TOUR_STEPS` and stay in the CLI
 * tutorial, which is read sitting down by somebody who has just run an install and can act on them.
 *
 * The trade is real and worth stating rather than hiding: a reader who only ever sees the carousel
 * does not meet "name the consequence first" here, and meets it in the agent rules `init` writes,
 * in `/reticle`, and in the first verdict they read. What this buys is a tour somebody finishes.
 */
const ORDERED_STEPS: readonly TourCard[] = [...TOUR_STEPS.slice(0, 1), ...TOUR_HUD_STEPS];

/** The slide after the last step: the moves somebody makes next, ready to paste. */
export const HANDOFF_INDEX = ORDERED_STEPS.length;

/** Every slide, including the handoff. */
export const SLIDE_COUNT = ORDERED_STEPS.length + 1;

export const TOUR_ATTR = 'data-reticle-tour';
/** Marks the element under test and under the highlight, so a test need not guess a class name. */
export const TOUR_TARGET_ATTR = 'data-reticle-tour-target';
/** Which of the handoff prompts a row and its button belong to. */
export const TOUR_PROMPT_ATTR = 'data-reticle-tour-prompt';

/**
 * What the copy button says, in each of the three states it actually has.
 *
 * It had one. `copy` was called and the button never changed, so the only way to find out whether
 * anything reached the clipboard was to go and paste somewhere — and the one case where nothing
 * could possibly have been copied, a page on an insecure origin with no `navigator.clipboard`,
 * looked exactly like success. A button that reports nothing is indistinguishable from a broken one.
 */
export const COPY_LABEL = 'Copy';
export const COPIED_LABEL = 'Copied';
/**
 * The honest answer when there is no clipboard to write to. The text is selected at the same time,
 * so the instruction is one keystroke rather than a dead end.
 */
export const COPY_MANUAL_LABEL = 'Selected — press Ctrl/Cmd+C';
/** How long the flash lasts before the button says `Copy` again. */
export const COPY_FLASH_MS = 1600;

export interface TourSlide {
  readonly index: number;
  readonly title: string;
  readonly body: string;
  readonly anchor: TourAnchor;
  /** Set when the ringed control is ours and the click is meant to reach it. */
  readonly tryIt?: string;
  /** The handoff slide carries the prompts; every other slide carries none. */
  readonly prompts?: readonly TourPrompt[];
}

const stepSlide = (step: TourCard, index: number): TourSlide => ({
  index,
  title: step.title,
  body: step.say,
  anchor: step.anchor ?? TourAnchor.NONE,
  ...(undefined === step.tryIt ? {} : { tryIt: step.tryIt }),
});

/**
 * Is this slide's target one the tour should let somebody click?
 *
 * The invitation and the hole are one decision, so they read from one place. A slide that says
 * "open it" over a scrim that eats the click is worse than one that says nothing: it asks for an
 * action and then silently refuses it, and the person concludes the button is broken.
 */
export const isInteractive = (slide: TourSlide): boolean => undefined !== slide.tryIt;

/**
 * The slides, in order.
 *
 * The handoff is generated rather than written into `TOUR_STEPS`, because it is not a step of the
 * loop — it is what to do once the loop is understood, and putting it in the shared list would make
 * the CLI print a "paste this" slide at somebody who is already in a terminal.
 */
export function tourSlides(): readonly TourSlide[] {
  return [
    ...ORDERED_STEPS.map(stepSlide),
    {
      index: HANDOFF_INDEX,
      title: 'Get Started',
      // Names WHERE, because this is the last thing between somebody and the point of the product
      // and "paste this to your agent" assumes they have already worked out which window that is.
      // The clients are named rather than described: a person who uses one recognises it instantly,
      // and a person who uses none learns that any of them will do.
      body: 'Paste one of these into Claude Code, Cursor, Codex, or whatever you use.',
      anchor: TourAnchor.NONE,
      prompts: TOUR_HANDOFF_PROMPTS,
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
 * Escape, then render the backtick spans the prose is written in.
 *
 * The steps are shared with a terminal, where `like this` is the ordinary way to mark a call inside
 * a sentence. In a card it was rendered as the literal character, so the most important slide in the
 * tour read "Only `reticle_act_and_wait` and `reticle_assert` produce a verdict" with the backticks
 * on screen. A tour whose argument is precision should not look like unrendered markup.
 *
 * Escaping happens FIRST and the replacement only ever emits a `<code>` around already-escaped text,
 * so this cannot become an injection point if a step is ever built from something we did not write.
 */
export function withInlineCode(text: string): string {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code class="reticle-tour-code">$1</code>');
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

/** A box, in the only four numbers this file needs from one. */
export interface TourRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The viewport, minus a hole.
 *
 * A real hole, rather than a transparent scrim. The spotlight's `0 0 0 9999px` shadow only makes the
 * page LOOK cut out; the scrim over it still has `pointer-events:auto`, so a click on the lit
 * control was swallowed by the tour. That is fine for a slide that only says "look at this", and
 * unacceptable for one that says "open it" — the button appears to do nothing, and the conclusion a
 * person draws is about the product rather than about the overlay.
 *
 * So the dimming and the click-blocking are separated: four rects around the target block clicks
 * everywhere except on it, and the shadow goes on doing the dimming. Zero-area rects are dropped
 * rather than emitted, because a `0`-height absolute div at the top of the page is still a node in
 * everybody's inspector.
 */
export function holeRects(
  box: TourRect,
  viewWidth: number,
  viewHeight: number,
): readonly TourRect[] {
  const left = Math.max(0, box.left);
  const top = Math.max(0, box.top);
  const right = Math.min(viewWidth, box.left + box.width);
  const bottom = Math.min(viewHeight, box.top + box.height);
  const candidates: readonly TourRect[] = [
    { left: 0, top: 0, width: viewWidth, height: top },
    { left: 0, top: bottom, width: viewWidth, height: viewHeight - bottom },
    { left: 0, top, width: left, height: bottom - top },
    { left: right, top, width: viewWidth - right, height: bottom - top },
  ];
  return candidates.filter((r) => r.width > 0 && r.height > 0);
}

/** One slide's inner markup. */
export function slideHtml(slide: TourSlide): string {
  const dots = tourSlides()
    .map(
      (s) =>
        `<span class="reticle-tour-dot${s.index === slide.index ? ' is-on' : ''}" aria-hidden="true"></span>`,
    )
    .join('');
  const tryIt =
    undefined === slide.tryIt
      ? ''
      : `<p class="reticle-tour-try" ${TOUR_TARGET_ATTR}="try">${escapeHtml(slide.tryIt)}</p>`;
  const prompt =
    undefined === slide.prompts
      ? ''
      : `<div class="reticle-tour-prompts">` +
        slide.prompts
          .map(
            (p, i) =>
              `<div class="reticle-tour-prompt" ${TOUR_PROMPT_ATTR}="${String(i)}">` +
              `<span class="reticle-tour-prompt-label">${escapeHtml(p.label)}</span>` +
              `<pre class="reticle-tour-prompt-text">${escapeHtml(p.text)}</pre>` +
              `<button type="button" class="reticle-tour-copy" ${TOUR_TARGET_ATTR}="copy" ` +
              `${TOUR_PROMPT_ATTR}="${String(i)}">${COPY_LABEL}</button></div>`,
          )
          .join('') +
        `</div>`;
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
    `<p class="reticle-tour-body">${withInlineCode(slide.body)}</p>` +
    tryIt +
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
  backdrop-filter:blur(1.5px);pointer-events:auto;z-index:0;}
/* Blocks the click everywhere the hole is not. Same job as the scrim, minus the one rectangle the
   slide is inviting somebody to press. */
[${TOUR_ATTR}] .reticle-tour-blocker{position:absolute;pointer-events:auto;z-index:0;}
/* Ringed slides dim through the ring's own 9999px shadow, which leaves a hole over the thing being
   pointed at. The scrim would cover that hole -- dimming the HUD the slide is ABOUT, and washing
   the page twice (~80% rather than 55%).
   It is cleared for the clicks too, and that half was missing. A scrim blocks only while it is
   VISIBLY blocking: reported from the field on 3.1.0 by several users, one of whom removed the
   plugin, because a cleared scrim went on eating every press on a page that looked lit and
   reachable. An overlay that looks transparent and behaves opaque reads as the app being broken. */
[${TOUR_ATTR}] .reticle-tour-scrim.is-clear{background:transparent;backdrop-filter:none;
  pointer-events:none;}
/* Above the ring, and the z-index is the whole point.
   The ring is appended after the card, and both are positioned with an auto z-index, so the ring
   painted on top of it -- and the ring's dimming IS a 9999px shadow, which therefore fell across the
   card as well. On every ringed slide the card was washed at 55% and read as sitting BEHIND the page
   it was drawn over. The ring must stay above the scrim and below the card; saying so explicitly is
   the fix, because DOM order alone cannot express "between these two". */
[${TOUR_ATTR}] .reticle-tour-card{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:min(430px,calc(100vw - 32px));box-sizing:border-box;pointer-events:auto;z-index:3;
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
/* A call named inside a sentence. Sets its own colour for the reason every other text class does:
   an inherited one loses to any direct element selector in the host app. */
[${TOUR_ATTR}] .reticle-tour-code{padding:1px 5px;border-radius:5px;background:#0c0e14;
  border:1px solid #232834;color:#9fb6ff;
  font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;}
[${TOUR_ATTR}] .reticle-tour-try{margin:0 0 12px;padding:8px 10px;border-radius:8px;
  background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.32);color:#c7cbff;
  font-size:12.5px;font-weight:550;}
[${TOUR_ATTR}] .reticle-tour-prompts{display:flex;flex-direction:column;gap:8px;margin:0 0 12px;}
[${TOUR_ATTR}] .reticle-tour-prompt{display:grid;gap:6px;padding:9px 10px;border-radius:8px;
  background:#0c0e14;border:1px solid #232834;
  grid-template-columns:1fr auto;grid-template-areas:"label copy" "text text";align-items:center;}
[${TOUR_ATTR}] .reticle-tour-prompt-label{grid-area:label;color:#8a93a6;font-size:11px;
  letter-spacing:.05em;text-transform:uppercase;}
[${TOUR_ATTR}] .reticle-tour-prompt-text{grid-area:text;width:100%;box-sizing:border-box;margin:0;
  white-space:pre-wrap;overflow-wrap:anywhere;color:#c9cedb;
  font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;}
[${TOUR_ATTR}] .reticle-tour-copy{grid-area:copy;padding:5px 10px;border-radius:6px;
  border:1px solid #2b303d;background:transparent;color:#c9cedb;font:inherit;font-size:11.5px;
  font-weight:600;cursor:pointer;white-space:nowrap;}
[${TOUR_ATTR}] .reticle-tour-copy:hover{background:rgba(255,255,255,.07);color:#fff;}
/* The flash that tells somebody the click did something. Colour AND text: colour alone is not an
   answer for the people who cannot see the difference. */
[${TOUR_ATTR}] .reticle-tour-copy.is-done{background:#16a34a;border-color:#16a34a;color:#fff;}
[${TOUR_ATTR}] .reticle-tour-copy.is-manual{background:#b45309;border-color:#b45309;color:#fff;}
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
[${TOUR_ATTR}] .reticle-tour-ring{position:absolute;border-radius:14px;pointer-events:none;z-index:1;
  box-shadow:0 0 0 3px #6366f1,0 0 0 9999px rgba(6,8,14,.55);transition:all .25s ease;}
/* A ring somebody is being asked to press, rather than to look at: it pulses, so the invitation in
   the prose has something on the page agreeing with it. */
[${TOUR_ATTR}] .reticle-tour-ring.is-live{animation:reticle-tour-pulse 1.8s ease-in-out infinite;}
@keyframes reticle-tour-pulse{
  0%,100%{box-shadow:0 0 0 3px #6366f1,0 0 0 9999px rgba(6,8,14,.55);}
  50%{box-shadow:0 0 0 6px rgba(99,102,241,.55),0 0 0 9999px rgba(6,8,14,.55);}
}
/* A REGION, not a target. The spotlight above cuts a hole in the dimming, which is right for
   something small and wrong for the app: the hole becomes the whole viewport, the dimming
   disappears, and the card is left competing with a fully lit page while the ring edges sit off at
   the margins pointing at nothing. An outline says "all of this" without turning the lights on. */
[${TOUR_ATTR}] .reticle-tour-ring.is-region{box-shadow:none;border:2px dashed #7c83f5;
  background:rgba(99,102,241,.06);}
@media (prefers-reduced-motion:reduce){
  [${TOUR_ATTR}] .reticle-tour-ring{transition:none;}
}
`;
