import { EventType, PerfMetric } from '@reticlehq/core';
import { refs } from '@/dom/addressing/refs.js';
import { getTestIdAttr, readTestId } from '@/dom/addressing/testid-attr.js';
import { isReticleOverlay } from '@/dom/dom-ignore.js';
import { isElement } from '@/dom/realm.js';
import type { Emit, Teardown } from './types.js';

/** One element a layout shift moved, with where it was and where it went. */
interface LayoutShiftSource {
  node?: Node | null;
  previousRect?: DOMRectReadOnly;
  currentRect?: DOMRectReadOnly;
}

/** A layout-shift entry carries the shift value + whether it followed recent input (excluded from CLS). */
interface LayoutShiftEntry extends PerformanceEntry {
  value?: number;
  hadRecentInput?: boolean;
  sources?: readonly LayoutShiftSource[];
}

/** The element a CLS event names: a ref to act on, and a short selector a person can read. */
interface ShiftedElement {
  ref: string;
  selector: string;
}

const areaOf = (r: DOMRectReadOnly | undefined): number =>
  r === undefined ? 0 : Math.max(0, r.width) * Math.max(0, r.height);

/** An identifier for a CSS selector: `CSS.escape` where the page has it, an equivalent otherwise. */
function cssIdent(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if ('function' === typeof css?.escape) return css.escape(value);
  // The CSSOM serialisation rules, for the characters an id or class can carry: a digit that would
  // start the identifier becomes a hex escape, anything outside [\w-] is backslash-escaped.
  let out = '';
  for (const [i, ch] of [...value].entries()) {
    const startsWithDigit = /\d/.test(ch) && (0 === i || (1 === i && value.startsWith('-')));
    if (startsWithDigit) out += `\\${ch.charCodeAt(0).toString(16)} `;
    else if (/[\w-]/.test(ch)) out += ch;
    else out += `\\${ch}`;
  }
  return out;
}

/**
 * `[data-testid="x"]`, `tag#id`, or `tag.first-class`: enough to recognise, short enough to stay
 * small. Every value is escaped, so an id or class with CSS-significant characters, or a test id with
 * a quote in it, still yields a selector that matches the element it names.
 */
function shortSelector(el: Element): string {
  const testid = readTestId(el);
  if (null !== testid) return `[${getTestIdAttr()}="${testid.replace(/["\\]/g, '\\$&')}"]`;
  const tag = el.tagName.toLowerCase();
  if (0 < el.id.length) return `${tag}#${cssIdent(el.id)}`;
  const cls = el.classList.item(0);
  return null === cls ? tag : `${tag}.${cssIdent(cls)}`;
}

/**
 * The element that moved most in this shift, or undefined when none can be named.
 *
 * The running CLS value says THAT the page shifted and nothing about what moved, so an agent could
 * see the regression and had nowhere to look (#1266). Only the largest source is named, by the area
 * it covered before or after, so the event stays small. A text node is named by its parent; Reticle's
 * own overlay is never named, since it is not the app.
 */
function largestShifted(
  sources: readonly LayoutShiftSource[] | undefined,
): ShiftedElement | undefined {
  let best: { el: Element; area: number } | undefined;
  for (const source of sources ?? []) {
    const node = source.node ?? null;
    const el = null === node ? null : isElement(node) ? node : node.parentElement;
    if (null === el || isReticleOverlay(el)) continue;
    const area = Math.max(areaOf(source.previousRect), areaOf(source.currentRect));
    if (best === undefined || area > best.area) best = { el, area };
  }
  return best === undefined
    ? undefined
    : { ref: refs.refFor(best.el), selector: shortSelector(best.el) };
}

/**
 * Observe the web-perf signals a screenshot tool fundamentally cannot verify — largest-contentful-paint
 * (LCP), cumulative layout shift (CLS), and long tasks — and emit them into the ring buffer so an agent
 * can assert "no layout shift on load" or "LCP under 2.5s". No-ops when PerformanceObserver or a given
 * entry type is unavailable (jsdom / older browsers), so it never throws in an unsupported context.
 *
 * Each event carries `at` (the entry's own startTime) so a consumer can reason about WHEN the metric
 * occurred rather than when it was flushed — buffered:true replays pre-install entries, whose emit time
 * would otherwise be install time.
 */
export function installPerf(emit: Emit): Teardown {
  if (typeof PerformanceObserver !== 'function') return () => undefined;
  const observers: PerformanceObserver[] = [];
  const observe = (type: string, handle: (entry: PerformanceEntry) => void): void => {
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) handle(entry);
      });
      po.observe({ type, buffered: true });
      observers.push(po);
    } catch {
      /* entry type unsupported in this browser — skip it, leave the others installed */
    }
  };

  // CLS is CUMULATIVE: sum qualifying shifts and report the running total, not each isolated shift.
  // ponytail: naive running sum — no session-windowing (5s window / 1s gap); enough for
  // "no layout shift on load" and trend, upgrade to windowed sessions if a CWV-exact number is needed.
  let cls = 0;
  // LCP only grows across candidates — surface a value only when it exceeds the last, not every candidate.
  let lcp = 0;

  observe('largest-contentful-paint', (e) => {
    const value = Math.round(e.startTime);
    if (value <= lcp) return;
    lcp = value;
    emit(EventType.PERF, { metric: PerfMetric.LCP, value, at: value });
  });
  observe('layout-shift', (e) => {
    const ls = e as LayoutShiftEntry;
    // Shifts within 500ms of a user input are expected (not CLS) — the spec's hadRecentInput flag.
    if (true === ls.hadRecentInput) return;
    cls += ls.value ?? 0;
    const shifted = largestShifted(ls.sources);
    emit(EventType.PERF, {
      metric: PerfMetric.CLS,
      value: cls,
      at: Math.round(e.startTime),
      ...(shifted === undefined ? {} : { shifted }),
    });
  });
  observe('longtask', (e) => {
    emit(EventType.PERF, {
      metric: PerfMetric.LONGTASK,
      value: Math.round(e.duration),
      at: Math.round(e.startTime),
    });
  });

  return () => {
    for (const po of observers) po.disconnect();
  };
}
