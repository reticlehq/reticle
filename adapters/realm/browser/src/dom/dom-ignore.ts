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
 */
export const RETICLE_OVERLAY: string =
  '[data-reticle-overlay],[data-reticle-cursor],[data-reticle-hud],[data-reticle-glow],[data-reticle-mark],[data-reticle-blocker],[data-reticle-tour]';

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

/** True if the element should be excluded from snapshots/queries (Reticle overlay or dev overlay). */
export function isIgnored(el: Element): boolean {
  // With the hatch open, Reticle's own overlay drops out of the ignore set — but the third-party
  // dev overlays do not. They are somebody else's furniture and were never the thing being verified.
  const ours = presenterVisible ? '' : RETICLE_OVERLAY;
  const sel = [ours, DEV_OVERLAYS, extraIgnore].filter((part) => part.length > 0).join(',');
  return el.closest(sel) !== null;
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
    if (el.closest(RETICLE_OVERLAY) !== null) continue;
    if (el instanceof HTMLElement && (el.hidden || null !== el.closest('[hidden]'))) continue;
    if (el instanceof HTMLElement && 'none' === getComputedStyle(el).display) continue;
    return true;
  }
  return false;
}
