import { RETICLE_OVERLAY_SELECTOR } from '@reticlehq/core';
import { capturedRootOf } from './shadow-registry.js';
import { isVisible } from './visibility.js';

/**
 * Selectors for Reticle's own presenter overlay (cursor, HUD, glow) + the annotator's
 * UI (`data-reticle-mark`) - never observed/snapshotted. The annotator mounts by DEFAULT with the
 * presenter, so omitting its selector here leaked annotation chrome into every snapshot.
 *
 * `data-reticle-tour` is here for the same reason, and it was missing. The first-run tour declines
 * only for a page Reticle itself opened, so a page opened by any OTHER automation — Playwright, a CI
 * harness, a developer's own tab — gets it. Driving bench-app through the MCP surface on such a page:
 * `reticle_look { action: "page" }` listed `dialog "Reticle tour"` with its Skip and Next buttons and
 * named it in `visibleDialogs`, and every act came back `occluded: true` against a 1440x900 div at
 * 0,0 that resolved to the tour's own scrim. The occlusion detector was right; the thing in the way
 * was us, described to the agent as part of the app it was sent to verify.
 *
 * The list itself lives in core (`RETICLE_OVERLAY_SELECTOR`), because the daemon hides the same set
 * from its screenshots (#1355).
 */
export const RETICLE_OVERLAY: string = RETICLE_OVERLAY_SELECTOR;

/** Known third-party dev overlays to keep out of snapshots (Agentation, Next dev UI). */
const DEV_OVERLAYS =
  '[data-agentation],#__next-build-watcher,nextjs-portal,[data-nextjs-dialog],[data-nextjs-toast]';

let extraIgnore = '';

/**
 * Whether Reticle's OWN UI is visible to snapshots and queries.
 *
 * Off, always, unless an app opts in — and the opt-in exists for exactly one situation: the app
 * under test IS Reticle. A HUD change is otherwise the only kind of change Reticle cannot be used to
 * check, because the panel that renders it is invisible to every tool that could look at it.
 *
 * It stays off by default because the reason for hiding it is sound: an agent that can drive
 * Reticle's own interface can fabricate its own impact report, and a snapshot full of Reticle chrome
 * is noise in every other app on earth. This is a hatch for contributors, not a setting.
 *
 * Third-party dev overlays stay ignored either way — they are somebody else's furniture and were
 * never the thing being verified.
 */
let presenterVisible = false;

/**
 * Make Reticle's own presenter visible to snapshots and queries. Contributors only.
 *
 * Deliberately a function rather than a field on the ignore set, so the one place that decides
 * "is this ours" also decides "may it be seen", and no caller can half-apply it.
 */
export function setPresenterVisible(visible: boolean): void {
  presenterVisible = visible;
}

/**
 * The Harness is the one acting. It never targets Reticle's own UI, hatch or not: with the hatch
 * open for dogfooding, a Harness model clicked the HUD's own plan card as if it were the app.
 */
let harnessViewing = false;

/** Set around each command by who sent it (`CommandActor.HARNESS`). */
export function setPresenterViewer(harness: boolean): void {
  harnessViewing = harness;
}

/** The hatch is open for whoever is looking now: never for the Harness. */
const exposed = (): boolean => presenterVisible && !harnessViewing;

/** Whether the hatch is open — reported in the app's capabilities so a verdict is never mistaken. */
export function isPresenterVisible(): boolean {
  return presenterVisible;
}

/** Let the host app add selectors to exclude from snapshots (e.g. its own dev widgets). */
export function setIgnoreSelectors(selectors: string[]): void {
  extraIgnore = selectors.join(',');
}

/** True if the element is part of Reticle's own presenter overlay. */
export function isReticleOverlay(el: Element): boolean {
  return el.closest(RETICLE_OVERLAY) !== null;
}

/** The HUD's panels and controls: what the hatch exposes to the DOM observer. */
const HUD_DOCK = '[data-reticle-dock]';

/**
 * Whether the DOM observer skips this element's changes: Reticle's own UI, except the HUD's panels
 * while the hatch is open, so an agent verifying the HUD sees "Run Harness became Stop" like any app
 * change. The cursor and glow stay out even then: they move on every action and prove nothing.
 */
export function isUnobserved(el: Element): boolean {
  if (!isReticleOverlay(el)) {
    return false;
  }
  return !exposed() || null === el.closest(HUD_DOCK);
}

/**
 * True iff the element is part of Reticle's OWN UI - the presenter overlay, the HUD, the synthetic
 * cursor, the glow, or the annotator's marks - or lives inside one of them.
 *
 * NOT "any ancestor carries a data-reticle* attribute", which is wrong twice over.
 * `data-reticle-mark-active` sits on <html> while annotate mode is live, so the whole document
 * answers yes; and `data-reticle-source` is stamped by the Vite/Babel plugins on every element the
 * APP renders, so in an instrumented app - which is the only kind there is - most of the page answers
 * yes too. Those attributes describe page content; they do not make it Reticle's.
 *
 * Two things read this and both fail silently under that rule. `pageElementAt` (annotator) skips
 * every stamped element and anchors the note to the outermost unstamped ancestor, i.e. the app shell
 * instead of the control under the cursor. `occlusion.ts` reads a yes as "nothing to report", so
 * occlusion detection comes back clean wherever the stamp reaches.
 */
export function isReticleUi(node: Element | null): boolean {
  return node !== null && node.closest(RETICLE_OVERLAY) !== null;
}

/**
 * What Reticle SAYS on its HUD: the log, the Harness log, the status pill and the agent's lines.
 * Never a match source, hatch open or not: with the HUD exposed, its narration ("Finding \"Open on
 * dashboard\"") satisfied the very text predicate the agent was proving, an `already_true` on words
 * the agent itself caused.
 */
// The act strip's line (`data-reticle-act-line`) says the same words for each call; with the HUD
// shown it made a visible-text `until` on words the app never rendered come back "yes".
const HUD_NARRATION =
  '[data-reticle-log],[data-reticle-harness-log],[data-reticle-chat-pill-text],[data-reticle-agent-said],[data-reticle-agent-note],[data-reticle-act-line]';

/** True if the element should be excluded from snapshots/queries (Reticle overlay or dev overlay). */
export function isIgnored(el: Element): boolean {
  // With the hatch open, Reticle's own overlay drops out of the ignore set — but the third-party
  // dev overlays do not. They are somebody else's furniture and were never the thing being verified.
  const ours = exposed() ? HUD_NARRATION : RETICLE_OVERLAY;
  const sel = [ours, DEV_OVERLAYS, extraIgnore].filter((part) => part.length > 0).join(',');
  return el.closest(sel) !== null;
}

/**
 * Whether an element's words may never prove a text claim: everything `isIgnored` drops, and
 * Reticle's own UI hatch open or not. With the HUD exposed, any line it wrote (a plan, a persona, a
 * finding) proved a visible-text check the app never satisfied. The hatch keeps the HUD's controls
 * reachable by role and test id; its words are never the app's.
 */
export function isWordsIgnored(el: Element): boolean {
  return isIgnored(el) || isReticleOverlay(el);
}

/** The framework error dialogs that cover the whole page, by the name a verdict gives them. */
export const FrameworkErrorDialog = {
  NEXT: 'Next.js error dialog',
  VITE: 'Vite error overlay',
} as const;

/** Next mounts its dev UI in `nextjs-portal`. Only the dialog covers the page; the toast does not. */
const NEXT_PORTAL = 'nextjs-portal';
const NEXT_DIALOG = '[data-nextjs-dialog]';
/** Vite mounts this element only while it shows an error, and it covers the viewport. */
const VITE_OVERLAY = 'vite-error-overlay';

/**
 * The framework error dialog open over the page, and its host element, or undefined.
 *
 * `DEV_OVERLAYS` keeps Next's dev UI out of snapshots, so without this no check could see that an
 * error dialog covers the page, and a text check on the content under it answered `yes` (#1768).
 * Next 16 keeps the dialog mounted and hidden while it is collapsed to the issue badge, so only a
 * visible dialog counts. A mounted one made every check on the page read `covered`.
 */
function openFrameworkErrorDialog(doc: Document): { name: string; host: Element } | undefined {
  const vite = doc.querySelector(VITE_OVERLAY);
  if (vite !== null) {
    return { name: FrameworkErrorDialog.VITE, host: vite };
  }
  for (const portal of Array.from(doc.querySelectorAll(NEXT_PORTAL))) {
    const root = portal.shadowRoot ?? capturedRootOf(portal);
    const dialog = (root ?? portal).querySelector(NEXT_DIALOG);
    if (null !== dialog && isVisible(dialog)) {
      return { name: FrameworkErrorDialog.NEXT, host: portal };
    }
  }
  const light = doc.querySelector(NEXT_DIALOG);
  if (null === light || !isVisible(light)) {
    return undefined;
  }
  return { name: FrameworkErrorDialog.NEXT, host: light };
}

/**
 * The name of the framework error dialog over any of `matches`, or undefined. A match inside the
 * dialog itself (the Vite overlay's own text) is what a user sees, so it is not covered.
 */
export function dialogCovering(matches: readonly Element[]): string | undefined {
  const first = matches[0];
  if (first === undefined) {
    return undefined;
  }
  const dialog = openFrameworkErrorDialog(first.ownerDocument);
  if (dialog === undefined) {
    return undefined;
  }
  return matches.some((el) => !isInsideHost(el, dialog.host)) ? dialog.name : undefined;
}

/** Whether `el` is the dialog's host or inside it, across its shadow root. */
function isInsideHost(el: Element, host: Element): boolean {
  for (let node: Node | null = el; node !== null;) {
    if (node === host) {
      return true;
    }
    const root = node.getRootNode();
    node = node.parentNode ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return false;
}

/** What an app's modal looks like: a native `<dialog>` shown modally, or a library's `aria-modal`. */
const APP_MODAL = 'dialog[open], [aria-modal="true"]';

/**
 * Whether the app under test has a modal open, which is when Escape belongs to it and to nothing of
 * ours.
 *
 * A native `<dialog open>` alone missed every React modal library (#1019): Radix, MUI and
 * headless-ui render a `role="dialog"` element with `aria-modal="true"`. Some keep that element
 * mounted and hidden while closed, so only a VISIBLE one counts, and Reticle's own UI never does.
 */
export function appModalOpen(doc: Document): boolean {
  for (const el of Array.from(doc.querySelectorAll(APP_MODAL))) {
    if (el.closest(RETICLE_OVERLAY) !== null) {
      continue;
    }
    if (el instanceof HTMLElement && (el.hidden || null !== el.closest('[hidden]'))) {
      continue;
    }
    if (el instanceof HTMLElement && 'none' === getComputedStyle(el).display) {
      continue;
    }
    return true;
  }
  return false;
}
