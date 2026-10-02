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
   * The destructive-action guard consults this before granting the plain-navigation exemption. An
   * inline `onclick` is visible in the markup; a handler a framework attached in script is not, and
   * the framework is the one place that knows.
   *
   * `undefined` means "this element has no framework props to read", which is NOT the same answer as
   * `false`. A caller must treat it as unknown and refuse the exemption; only a definite `false`
   * ("I read the props, there is no handler") may narrow the guard.
   */
  hasClickHandler?: (el: Element) => boolean | undefined;
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
 * Three-valued on purpose. `true` as soon as one adapter says so, `false` when at least one adapter
 * actually read the props and found none, and `undefined` when no adapter could answer at all —
 * which is the case that must NOT be read as "no handler".
 */
export function elementHasClickHandler(el: Element): boolean | undefined {
  let answered = false;
  for (const adapter of adapters) {
    if (adapter.hasClickHandler === undefined) continue;
    const result = adapter.hasClickHandler(el);
    if (result === undefined) continue;
    answered = true;
    if (result) return true;
  }
  return answered ? false : undefined;
}

/** A handler written into the markup rather than bound in script. */
const INLINE_HANDLER_ATTR = 'onclick';

/**
 * Every click handler a page can state about this element, inline or framework-declared.
 *
 * An `onclick` written into the markup is visible on the element. A handler a FRAMEWORK attached is
 * not — nothing in the DOM records it — so the adapters are asked, which is the only place that
 * knows. `undefined` is "no adapter could read this element", and only a positive reading refuses
 * the exemption: a handler bound with plain `addEventListener` on a page with no adapter leaves no
 * trace at all, which is a named gap rather than a proof. See `isPlainNavigationLink` in core.
 */
export function elementHandlesClick(el: Element): boolean | undefined {
  if (el.hasAttribute(INLINE_HANDLER_ATTR)) return true;
  return elementHasClickHandler(el);
}

export function adapterNames(): string[] {
  return adapters.map((a) => a.name);
}
