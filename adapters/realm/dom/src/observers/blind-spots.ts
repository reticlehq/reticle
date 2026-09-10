import { EventType, BlindSpotKind } from '@reticlehq/core';
import type { Emit, Teardown } from './types.js';
import { countUnmountedRows } from '../dom/virtualized.js';
import { isCaptured } from '../dom/shadow-registry.js';
import { sameOriginFrameBodies } from './frames.js';
import { nativeClearTimeout, nativeSetTimeout } from '../timers/native-timers.js';

/**
 * Blind-spot sensor. The SDK instruments the DOM, but a cross-origin iframe is a wall it cannot
 * see through — its contents, network, and console are invisible. Left unstated, a green verdict would
 * imply the whole page was verified. This detects cross-origin frames and emits a BLIND_SPOT event so the
 * server can mark results `coverage: partial` instead of lying by omission. This sensor owns the three
 * kinds cheaply and reliably detectable from the page: cross-origin frames, closed shadow roots, and
 * virtualized-unmounted rows.
 */

/**
 * Elements rendering content nobody outside them can read.
 *
 * `attachShadow({mode:'closed'})` makes `el.shadowRoot` null FOREVER, for every caller — Reticle,
 * Playwright's accessibility snapshot, a screenshot-reading model, all of them. There is no API that
 * recovers it, so the only honest behaviour is to say the region exists and is unreadable.
 *
 * It is not directly detectable either, so this infers it: a custom element (a dash in the tag name is
 * the spec's own rule) that has NO light-DOM children and no text, yet occupies layout space, is
 * painting from somewhere. Nothing else produces that combination — an empty custom element that
 * renders nothing measures zero and is skipped.
 */
export function countClosedShadowRoots(): number {
  let count = 0;
  for (const el of document.querySelectorAll<HTMLElement>('*')) {
    if (!el.tagName.includes('-')) continue;
    if (el.shadowRoot !== null) continue; // open — readable, not a blind spot
    // A closed root attached AFTER the SDK installed was captured from attachShadow's return value,
    // so it is readable too. Only what was genuinely missed is declared.
    if (isCaptured(el)) continue;
    if (el.children.length > 0) continue;
    if ((el.textContent ?? '').trim().length > 0) continue;
    if (el.offsetHeight <= 0 && el.offsetWidth <= 0) continue;
    count += 1;
  }
  return count;
}

/**
 * Whether a frame is cross-origin (unobservable). A same-origin frame exposes its `contentDocument`; a
 * cross-origin one returns null (or THROWS a SecurityError on access). A src-less / about:blank frame is
 * same-origin and simply not navigated — not a blind spot.
 */
export function isCrossOriginFrame(frame: HTMLIFrameElement): boolean {
  const src = frame.getAttribute('src');
  if (null === src || 0 === src.length) return false;
  try {
    return null === frame.contentDocument;
  } catch {
    return true; // SecurityError on access is itself proof of cross-origin
  }
}

/** How many of the given frames are cross-origin (unobservable). */
export function countCrossOriginFrames(frames: readonly HTMLIFrameElement[]): number {
  let count = 0;
  for (const frame of frames) if (isCrossOriginFrame(frame)) count += 1;
  return count;
}

function currentCount(): number {
  return countCrossOriginFrames(Array.from(document.querySelectorAll('iframe')));
}

/**
 * Same-origin frames — observed for DOM, NOT for network.
 *
 * Their `fetch` lives in the frame's own realm, which the top realm's patch never sees. Left
 * undeclared, `settled` can read true while a frame request is still in flight.
 */
function uninstrumentedFrameCount(): number {
  return sameOriginFrameBodies(document).length;
}

/**
 * Watch the page for cross-origin iframes and emit BLIND_SPOT whenever the count CHANGES (install +
 * on any added/removed frame). Only the delta is emitted — never a per-mutation flood — so a static
 * embed reports once. Reversible: disconnects the observer on teardown.
 */
/**
 * How long added/removed nodes are allowed to pile up before the frame count is re-checked.
 *
 * A blind spot is a coverage caveat on a verdict, not a live signal — noticing an embed a fraction of
 * a second later costs nothing, while checking on every mutation costs a DOM scan per render.
 */
const RECHECK_DEBOUNCE_MS = 250;

export function installBlindSpots(emit: Emit): Teardown {
  // Every kind is counted the same way and emitted on CHANGE only, so a static embed or a steady list
  // reports once instead of flooding. Virtualized rows matter most: without them an assertion over a
  // 10,000-row grid is a claim about the ~29 on screen, delivered as full coverage.
  const sensors = [
    { kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: currentCount },
    { kind: BlindSpotKind.UNINSTRUMENTED_FRAME, count: uninstrumentedFrameCount },
    { kind: BlindSpotKind.CLOSED_SHADOW_ROOT, count: countClosedShadowRoots },
    { kind: BlindSpotKind.VIRTUALIZED_UNMOUNTED, count: countUnmountedRows },
  ] as const;
  const last = new Map<string, number>();
  const report = (): void => {
    for (const sensor of sensors) {
      const count = sensor.count();
      if (count === last.get(sensor.kind)) continue;
      last.set(sensor.kind, count);
      if (count > 0) emit(EventType.BLIND_SPOT, { kind: sensor.kind, count });
    }
  };
  report();

  // Coalesce rather than gate.
  //
  // This used to try to skip unrelated churn by testing each added/removed node with
  // `n.querySelector('iframe')` — but that is a full subtree scan per mutated node, so a React commit
  // mounting a 500-node panel paid a 500-node scan to decide whether to do a document scan. The gate
  // cost more than the work, and it scaled with exactly the thing a large app does most.
  //
  // Since report() emits only when the count CHANGES, running it late and rarely is free. One
  // debounced document scan per quarter-second replaces per-node scanning, and it is also more
  // correct: the old gate's `querySelector` missed an iframe added inside a subtree whose own root
  // was a text or comment node.
  let pending: ReturnType<typeof nativeSetTimeout> | undefined;
  const observer = new MutationObserver(() => {
    if (pending !== undefined) return;
    pending = nativeSetTimeout(() => {
      pending = undefined;
      report();
    }, RECHECK_DEBOUNCE_MS);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return () => {
    if (pending !== undefined) nativeClearTimeout(pending);
    observer.disconnect();
  };
}
