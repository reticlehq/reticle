/** Framework adapter registry — enriches elements with component identity + source. */

export interface ComponentSource {
  file: string;
  line: number;
  column?: number;
}

export interface ComponentInfo {
  componentStack: string[];
  source?: ComponentSource;
}

export interface ReticleAdapter {
  name: string;
  identify: (el: Element) => ComponentInfo | null;
  /** Best-effort: read a component's hook state for a DOM element. */
  readState?: (el: Element) => unknown;
  /** Best-effort: does the element declare framework enter/leave handlers synthetic hover may not fire? */
  hasHoverHandlers?: (el: Element) => boolean;
  /**
   * Best-effort: does the element declare a framework click handler?
   *
   * The destructive-action guard consults this, and it can only ever ADD caution: `true` keeps the
   * block. There is deliberately no "no handler" answer here. A framework probe reads the
   * framework's own props, and a listener bound outside them (`ref.addEventListener`, or one on
   * `document` that delegation carries) is invisible to it and runs on the click all the same, so an
   * absence from this probe is not an absence anyone observed.
   *
   * A handlerless reading exists, but it does not come from here: it comes from a driver holding a
   * CDP session, which can list real listeners with `DOMDebugger.getEventListeners`. See
   * `clickListenersOn` on `RealInputProvider`.
   */
  hasClickHandler?: (el: Element) => boolean;
}

// Persist on a global so the registry survives HMR module re-evaluation (otherwise the
// adapter silently drops after a hot reload and source mapping degrades). See feedback #7.
const globalStore = globalThis as unknown as { __reticleAdapters?: ReticleAdapter[] };
const adapters: ReticleAdapter[] = (globalStore.__reticleAdapters ??= []);

/** Called by @reticlehq/react (and future adapters) to register themselves. */
export function registerAdapter(adapter: ReticleAdapter): void {
  if (!adapters.some((a) => a.name === adapter.name)) adapters.push(adapter);
}

/**
 * First adapter that can identify the element wins.
 *
 * Adapters are third-party code, so each call is contained: one that throws, or answers
 * `undefined` instead of `null`, costs that element its component name and nothing else.
 */
export function identifyComponent(el: Element): ComponentInfo | null {
  for (const adapter of adapters) {
    let info: ComponentInfo | null | undefined;
    try {
      info = adapter.identify(el);
    } catch {
      continue;
    }
    if (info !== null && info !== undefined) return info;
  }
  return null;
}

/** First adapter that returns non-undefined component state for the element wins. */
export function readComponentState(el: Element): unknown {
  for (const adapter of adapters) {
    if (adapter.readState === undefined) continue;
    const state = adapter.readState(el);
    if (state !== undefined) return state;
  }
  return undefined;
}

/**
 * True if any installed adapter reports framework enter/leave hover handlers on the element.
 * No-op-safe: returns false when no adapter is installed or none implements the probe.
 */
export function elementHasHoverHandlers(el: Element): boolean {
  for (const adapter of adapters) {
    if (adapter.hasHoverHandlers === undefined) continue;
    if (adapter.hasHoverHandlers(el)) return true;
  }
  return false;
}

/**
 * Whether any installed adapter reports a click handler on the element.
 *
 * `true` as soon as one adapter says so. There is deliberately NO `false`: an adapter reads the
 * framework's own props, and a listener bound outside them is invisible to it, so an absence it
 * reports is one it never observed. Returning `false` here would hand the guard an absence nobody
 * checked.
 */
export function elementHasClickHandler(el: Element): boolean | undefined {
  for (const adapter of adapters) {
    if (adapter.hasClickHandler === undefined) continue;
    if (adapter.hasClickHandler(el)) return true;
  }
  return undefined;
}

/** A handler written into the markup rather than bound in script. */
const INLINE_HANDLER_ATTR = 'onclick';

/**
 * The click handlers a PAGE can prove for this element: an inline `onclick`, or a framework's own
 * props. Anything else is `undefined`.
 *
 * `undefined` is the common answer and the honest one. A listener bound with `addEventListener`
 * leaves nothing in the DOM and nothing in any framework's props, so no in-page reading can rule one
 * out, and this must not pretend otherwise. The one in-page fact that IS provable is the markup
 * attribute.
 *
 * The complement comes from outside the page: a driver holding a CDP session can ask
 * `DOMDebugger.getEventListeners`, which reports real listeners including `addEventListener` ones,
 * and THAT is the only thing allowed to answer `false` to `isPlainNavigationLink`. See
 * `clickListenersOn` on `RealInputProvider`.
 */
export function elementHandlesClick(el: Element): boolean | undefined {
  if (el.hasAttribute(INLINE_HANDLER_ATTR)) return true;
  return elementHasClickHandler(el);
}

export function adapterNames(): string[] {
  return adapters.map((a) => a.name);
}
