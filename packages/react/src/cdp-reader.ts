/**
 * Read a React component's state from a page that never installed Reticle.
 *
 * `identify`/`readState` in this package read the same fiber, but they run IN-PROCESS: they close
 * over module helpers and are called by the SDK the app loaded. The zero-install path has no SDK — the
 * daemon is attached to an arbitrary page over CDP — so the reader has to travel INTO the page as
 * text and run there, which means it can reference nothing outside itself. That single constraint,
 * self-containment, is the reason this is a separate file rather than a reuse of `readState`.
 *
 * It works because the thing it reads is React's, not Reticle's: React stamps `__reactFiber$…` on
 * every host element regardless of what instrumentation is present. This is the same hook
 * react-devtools-mcp uses, which is exactly the tool the zero-install tier exists to reach parity
 * with — reusing our own algorithm rather than adopting theirs.
 *
 * What it CANNOT recover is the SDK-exclusive surface, and that limit is honest and load-bearing: no
 * custom signals (the app never emitted them), no registered store by name (`registerStore` was never
 * called), and no build-time `file:line` (the plugin never ran). Those are precisely the
 * inside-the-app truths the SDK is for. The capability report the CDP session emits must declare their
 * absence so a thin-tier green never implies the full one.
 */

/** The shape the injected reader returns. Mirrors ComponentStateResult but is defined here so the
 *  parser has no dependency on the in-process types (they may serialize differently). */
export interface CdpComponentRead {
  ok: boolean;
  reason?: string;
  component?: string;
  /** Positional hook states — React exposes no hook names, so order is the only key. */
  hooks?: unknown[];
}

/**
 * The reader, as a self-contained function.
 *
 * MUST reference nothing outside its own body: it is serialized with `.toString()` and evaluated in a
 * page that has none of this module's scope. That is enforced by a test that runs it through
 * `new Function` with an empty scope, so a stray closure reference fails loudly rather than throwing
 * `X is not defined` only on the live CDP path.
 *
 * Bounds and fail-soft behaviour match the in-process reader: cap the hook walk, guard cycles, and
 * degrade to `{ok:false, reason}` rather than throwing across the CDP boundary (where a throw becomes
 * an opaque evaluation error).
 */
export function readComponentAt(el: Element | null): CdpComponentRead {
  if (null === el) return { ok: false, reason: 'no-element' };
  try {
    const FIBER_PREFIXES = ['__reactFiber$', '__reactInternalInstance$'];
    const key = Object.keys(el).find((k) => FIBER_PREFIXES.some((p) => k.startsWith(p)));
    if (key === undefined) return { ok: false, reason: 'no-fiber' };
    type AnyFiber = {
      type?: unknown;
      return?: AnyFiber | null;
      alternate?: AnyFiber | null;
      stateNode?: unknown;
    };
    let fiber = (el as unknown as Record<string, AnyFiber | undefined>)[key];
    // React keeps two fibers per element (current ↔ work-in-progress) and swaps them on every commit,
    // but the `__reactFiber$…` key keeps pointing at the one created at mount — so from the second
    // render on it is the PREVIOUS commit's fiber half the time, and hooks read one commit behind.
    // Climb to the HostRoot: the tree is the committed one iff its FiberRoot's `current` is the top
    // fiber reached. Otherwise the committed counterpart is `alternate`. Unknown shape => leave as-is.
    const alternate = fiber?.alternate;
    if (fiber !== null && fiber !== undefined && alternate !== null && alternate !== undefined) {
      let top: AnyFiber = fiber;
      let climbed = 0;
      while (top.return !== null && top.return !== undefined && climbed < 200) {
        top = top.return;
        climbed += 1;
      }
      const committed = (top.stateNode as { current?: unknown } | null | undefined)?.current;
      if ('object' === typeof committed && null !== committed && committed !== top)
        fiber = alternate;
    }
    // Climb to the nearest function-component fiber; host fibers (strings) carry no hook state.
    let guard = 0;
    while (
      fiber !== null &&
      fiber !== undefined &&
      typeof (fiber as { type?: unknown }).type !== 'function' &&
      guard < 200
    ) {
      fiber = (fiber as { return?: typeof fiber }).return;
      guard += 1;
    }
    if (null === fiber || fiber === undefined) return { ok: false, reason: 'no-component-fiber' };
    const type = (fiber as { type?: { displayName?: string; name?: string } }).type;
    const component = type?.displayName ?? type?.name ?? undefined;
    const hooks: unknown[] = [];
    let hook = (fiber as { memoizedState?: unknown }).memoizedState;
    let i = 0;
    while (hook !== null && 'object' === typeof hook && i < 100) {
      const state = (hook as { memoizedState?: unknown }).memoizedState;
      // Only carry JSON-serializable primitives/plain values across the boundary; a function or DOM
      // node in a hook (a ref, a callback) is dropped rather than breaking the whole read.
      hooks.push('function' === typeof state ? '[fn]' : state);
      const next = (hook as { next?: unknown }).next;
      if (null === next || typeof next !== 'object') break;
      hook = next;
      i += 1;
    }
    return component === undefined ? { ok: true, hooks } : { ok: true, component, hooks };
  } catch {
    return { ok: false, reason: 'read-threw' };
  }
}

/**
 * The JS expression string to hand to `page.evaluate` / CDP `Runtime.evaluate`.
 *
 * Built from `readComponentAt.toString()` so the injected code and the unit-tested code are the SAME
 * source — there is no second hand-maintained copy to drift. `selector` is JSON-encoded so a testid
 * containing a quote cannot break out of the expression.
 */
export function buildReaderExpression(selector: string): string {
  return `(${readComponentAt.toString()})(document.querySelector(${JSON.stringify(selector)}))`;
}

/** Validate a raw CDP evaluation result into a typed read, so a malformed injection is caught here
 *  rather than surfacing as a confusing tool output. */
export function parseComponentRead(raw: unknown): CdpComponentRead {
  if (
    typeof raw !== 'object' ||
    null === raw ||
    typeof (raw as { ok?: unknown }).ok !== 'boolean'
  ) {
    return { ok: false, reason: 'malformed-read' };
  }
  return raw as CdpComponentRead;
}
