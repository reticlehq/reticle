import { registerAdapter, type ComponentInfo, type ComponentSource } from '@reticlehq/browser';
import {
  ComponentStateReason,
  DATA_RETICLE_SOURCE_ATTR,
  RETICLE_ROOT_GLOBAL,
  type ComponentStateResult,
} from '@reticlehq/core';

interface Hook {
  memoizedState: unknown;
  next: Hook | null;
}

/** Minimal shape of the React fiber fields we read. */
interface DebugSource {
  fileName: string;
  lineNumber: number;
  /** Nullable for the same reason as `_debugSource` itself — React leaves it null, not absent. */
  columnNumber?: number | null;
}
/**
 * React's `_debugSource.fileName` is ABSOLUTE; the babel stamp is repo-relative. Both surface to the
 * agent as `source`, so the same product emitted two path shapes depending on which React version an
 * app was on — and `/Users/someone/tmp/wt/apps/x/src/A.tsx` is noise in a report, not a pointer.
 * The build plugins define the root; without one we return the path unchanged rather than guessing.
 */
/** Backslashes to forward slashes, so a Windows path can be compared with a posix one. */
function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Make a source pointer repo-relative.
 *
 * Both sides of this comparison are native paths, and on Windows that means BACKSLASHES on both:
 * `C:\Users\dev\app` and `C:\Users\dev\app\src\Counter.tsx`. Building the prefix as
 * `root + '/'` produced `C:\Users\dev\app/` — a mixed separator that can never match the start of
 * the file — so on Windows the root was never stripped and every pointer came back as an absolute
 * path from the developer's own machine. Exactly what the root exists to prevent, on the platform
 * carrying two thirds of Reticle's users.
 *
 * Normalizing to posix fixes three cases at once: native Windows, the mixed pair Vite produces (it
 * normalizes module ids to forward slashes while `cwd()` stays native), and plain posix. The result
 * is always forward-slashed, because flow anchors and `file:line` pointers all speak posix.
 *
 * The drive letter is compared case-insensitively — Windows treats `C:\App` and `c:\app` as the
 * same path, and the two spellings routinely come from different APIs — but the returned suffix is
 * sliced from the ORIGINAL file, so nothing else gets case-folded.
 */
export function relativeToRoot(file: string): string {
  const root = (globalThis as Record<string, unknown>)[RETICLE_ROOT_GLOBAL];
  if (typeof root !== 'string' || 0 === root.length) return file;
  const normalizedRoot = toPosix(root).replace(/\/+$/, '');
  if (0 === normalizedRoot.length) return file;
  const normalizedFile = toPosix(file);
  const prefix = `${normalizedRoot}/`;
  const matches =
    normalizedFile.startsWith(prefix) ||
    normalizedFile.toLowerCase().startsWith(prefix.toLowerCase());
  return matches ? normalizedFile.slice(prefix.length) : file;
}

interface Fiber {
  return: Fiber | null;
  type: unknown;
  elementType: unknown;
  /**
   * NULLABLE, not merely absent. React writes `_debugSource: null` on fibers it has no JSX source
   * for — the old `?: DebugSource` type said "missing or a DebugSource", so `!== undefined` let the
   * null straight through to a dereference. Typing the null is what makes the compiler catch it.
   */
  _debugSource?: DebugSource | null;
  memoizedState?: unknown; // for a function component this is the head of the hook list
  memoizedProps?: unknown; // host fiber props incl. JSX event handlers
  /** The other half of React's fiber pair (current ↔ work-in-progress). Null before the 2nd render. */
  alternate?: Fiber | null;
  /** On the HostRoot fiber this is the FiberRoot, whose `current` names the committed tree. */
  stateNode?: unknown;
}

const FIBER_PREFIXES = ['__reactFiber$', '__reactInternalInstance$'];
const MAX_DEPTH = 200;
const MAX_HOOKS = 100;
const MAX_SERIALIZE_DEPTH = 4;
const MAX_SERIALIZE_KEYS = 50;
const MAX_SERIALIZE_ITEMS = 50;
/** Marker substituted for a DOM node so the agent sees the tag, never the (circular) node. */
const DOM_NODE_MARKER = '[Node]';

/**
 * Framework plumbing to hide from the component stack (React Router/Next internals, context
 * providers, error/suspense boundaries) so the agent sees *your* components, not the runtime.
 */
// KNOWN framework-internal component names (React runtime, Next App/Pages Router, react-router) plus
// dotted context render (`ThemeContext.Provider`). A curated list, NOT a generic `…Context$`/`…Provider$`
// suffix, so a user's `PricingContext`/`CheckoutProvider`/`UploadHandler` survives and source
// attribution can point at it instead of its parent.
const FRAMEWORK_NOISE =
  /(\.Provider|\.Consumer)$|^(Fragment|Suspense|StrictMode|Profiler|Root|ServerRoot|HotReload|AppContainer|ReactDevOverlay|__next|AppRouter|OuterLayoutRouter|InnerLayoutRouter|LayoutRouterContext|RenderFromTemplateContext|RouterContext|PathnameContext|SearchParamsContext|RedirectBoundary|NotFoundBoundary|RedirectErrorBoundary|HTTPAccessFallbackBoundary|BrowserRouter|MemoryRouter|HashRouter|Router|Routes|Route|Outlet)$/;

function isFrameworkNoise(name: string): boolean {
  return FRAMEWORK_NOISE.test(name);
}

/**
 * Resolve a fiber to the one in the COMMITTED tree.
 *
 * React keeps two fibers per element — `current` and its `alternate` (the work-in-progress) — and
 * swaps which is which on every commit. The `__reactFiber$…` key on a host DOM node keeps pointing at
 * the fiber object created at mount, so from the second render on it is the previous commit's fiber
 * half the time: hooks read off it alternate correct/stale, one commit behind.
 *
 * The principled test, not a heuristic: climb `return` to the HostRoot, whose `stateNode` is the
 * FiberRoot. The tree we climbed is the committed one iff `fiberRoot.current` is the top fiber we
 * reached. If it is not, the committed counterpart is `fiber.alternate`. Anything unrecognizable
 * (no alternate, no FiberRoot, a detached fiber) returns the fiber unchanged — a possibly-stale read
 * is still better than none, and this must never throw on a React version we have not seen.
 */
function currentFiber(fiber: Fiber): Fiber {
  const alternate = fiber.alternate;
  if (alternate === undefined || null === alternate) return fiber;
  let top = fiber;
  let depth = 0;
  while (top.return !== null && depth < MAX_DEPTH) {
    top = top.return;
    depth += 1;
  }
  const fiberRoot = top.stateNode;
  if (typeof fiberRoot !== 'object' || null === fiberRoot) return fiber;
  const committed = (fiberRoot as { current?: unknown }).current;
  if (typeof committed !== 'object' || null === committed) return fiber;
  return committed === top ? fiber : alternate;
}

function getFiber(el: Element): Fiber | null {
  const key = Object.keys(el).find((k) => FIBER_PREFIXES.some((p) => k.startsWith(p)));
  if (key === undefined) return null;
  const value = (el as unknown as Record<string, unknown>)[key];
  if (value === undefined || null === value) return null;
  return currentFiber(value as Fiber);
}

/** Display name of a component type (function, forwardRef/memo object, or host string). */
function componentName(type: unknown): string | null {
  if ('function' === typeof type) {
    const fn = type as { displayName?: string; name?: string };
    if (fn.displayName !== undefined && fn.displayName.length > 0) return fn.displayName;
    return fn.name !== undefined && fn.name.length > 0 ? fn.name : null;
  }
  if ('object' === typeof type && type !== null) {
    const obj = type as { displayName?: string };
    return obj.displayName !== undefined && obj.displayName.length > 0 ? obj.displayName : null;
  }
  return null;
}

/** Walk the fiber tree from a DOM node up to the root, collecting components + source. */
export function identify(el: Element): ComponentInfo | null {
  let fiber = getFiber(el);
  const stack: string[] = [];
  const rawStack: string[] = [];
  let source: ComponentSource | undefined;
  let depth = 0;

  while (fiber !== null && depth < MAX_DEPTH) {
    depth += 1;
    const name = componentName(fiber.elementType ?? fiber.type);
    if (name !== null && rawStack[rawStack.length - 1] !== name) {
      rawStack.push(name);
      if (!isFrameworkNoise(name) && stack[stack.length - 1] !== name) stack.push(name);
    }
    // `identify()` is on the ACT path as well as the inspect path, so one null fiber anywhere in
    // this walk used to take out reticle_act / reticle_act_and_wait / reticle_inspect for the whole
    // app: the read-only tools kept working, so the agent could see the app perfectly and could not
    // touch it. The throw also pre-empted the React 19 attribute fallback below, which would have
    // produced the source anyway.
    const debugSource = fiber._debugSource;
    if (source === undefined && debugSource !== undefined && debugSource !== null) {
      source = { file: relativeToRoot(debugSource.fileName), line: debugSource.lineNumber };
      const column = debugSource.columnNumber;
      if (column !== undefined && column !== null) source.column = column;
    }
    fiber = fiber.return;
  }

  // React 19 dropped `_debugSource`; fall back to a data-reticle-source stamp if present
  // (added by @reticlehq/babel-plugin in dev).
  if (source === undefined) {
    source = sourceFromAttribute(el);
  }

  // Prefer the de-noised stack; fall back to the nearest raw name if filtering left nothing.
  const componentStack = stack.length > 0 ? stack : rawStack.slice(0, 1);
  if (0 === componentStack.length && source === undefined) return null;
  const info: ComponentInfo = { componentStack };
  if (source !== undefined) info.source = source;
  return info;
}

function sourceFromAttribute(el: Element): ComponentSource | undefined {
  const stamped = el.closest(`[${DATA_RETICLE_SOURCE_ATTR}]`);
  const raw = stamped?.getAttribute(DATA_RETICLE_SOURCE_ATTR);
  if (null === raw || raw === undefined) return undefined;
  const match = /^(.*):(\d+):(\d+)$/.exec(raw);
  if (null === match) return undefined;
  const [, file, line, column] = match;
  if (file === undefined || line === undefined || column === undefined) return undefined;
  return { file, line: Number(line), column: Number(column) };
}

/** Find the nearest function-component fiber above a host node. */
function nearestComponentFiber(el: Element): Fiber | null {
  let fiber = getFiber(el);
  let depth = 0;
  while (fiber !== null && depth < MAX_DEPTH) {
    depth += 1;
    if ('function' === typeof fiber.type || 'function' === typeof fiber.elementType) return fiber;
    fiber = fiber.return;
  }
  return null;
}

/**
 * JSON-safe projection of an arbitrary hook value. Drops functions/DOM nodes/cycles and
 * bounds depth/breadth, so the result handed to `JSON.stringify` downstream can never throw.
 * Raw hook states routinely hold `useRef` DOM nodes, dispatchers, and circular fiber backrefs —
 * serializing those un-guarded can cause hangs. Never throws.
 */
function safeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (null === value) return null;
  const t = typeof value;
  if ('string' === t || 'number' === t || 'boolean' === t) return value;
  if ('undefined' === t || 'function' === t || 'symbol' === t || 'bigint' === t) return null;
  if (typeof Node !== 'undefined' && value instanceof Node) return DOM_NODE_MARKER;
  if (depth >= MAX_SERIALIZE_DEPTH) return null;
  const obj = value as object;
  if (seen.has(obj)) return null;
  seen.add(obj);
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_SERIALIZE_ITEMS).map((v) => safeValue(v, depth + 1, seen));
    seen.delete(obj);
    return out;
  }
  const out: Record<string, unknown> = {};
  const keys = Object.keys(obj).slice(0, MAX_SERIALIZE_KEYS);
  for (const key of keys) {
    out[key] = safeValue((obj as Record<string, unknown>)[key], depth + 1, seen);
  }
  seen.delete(obj);
  return out;
}

/**
 * Best-effort, bounded read of a function component's hook states by walking memoizedState.next.
 * React does not expose hook *names*; we return positional, sanitized state values. State for
 * class components / host fibers is skipped. Layout is React-version-specific — fail soft to a
 * structured `{ ok: false, reason }` rather than throwing or producing an unserializable value.
 */
/** Build a success result, omitting `component` when the name is unknown (exactOptional-safe). */
function ok(name: string | null, hooks: unknown[]): ComponentStateResult {
  return null === name ? { ok: true, hooks } : { ok: true, component: name, hooks };
}

export function readState(el: Element): ComponentStateResult {
  try {
    const fiber = nearestComponentFiber(el);
    if (null === fiber) {
      return { ok: false, reason: ComponentStateReason.UNAVAILABLE };
    }
    const name = componentName(fiber.elementType ?? fiber.type);
    const head = fiber.memoizedState;
    if (typeof head !== 'object' || null === head) {
      return ok(name, []);
    }
    const hooks: unknown[] = [];
    const seen = new WeakSet<object>();
    let hook = head as Hook;
    let i = 0;
    while ('object' === typeof hook && i < MAX_HOOKS) {
      hooks.push(safeValue(hook.memoizedState, 0, seen));
      const next = hook.next;
      if (null === next || typeof next !== 'object') break;
      hook = next;
      i += 1;
    }
    return ok(name, hooks);
  } catch {
    return { ok: false, reason: ComponentStateReason.UNAVAILABLE };
  }
}

const HOVER_HANDLER_KEYS = [
  'onMouseEnter',
  'onMouseLeave',
  'onPointerEnter',
  'onPointerLeave',
] as const;

/**
 * True if the element's host fiber declares React enter/leave handlers. Synthetic dispatchEvent
 * does not reliably trigger React's native enter/leave synthesis (no hit-testing), so callers warn.
 * Fail soft: an unexpected fiber shape returns false.
 */
export function hasHoverHandlers(el: Element): boolean {
  const fiber = getFiber(el);
  const props = fiber?.memoizedProps;
  if (typeof props !== 'object' || null === props) return false;
  const p = props as Record<string, unknown>;
  return HOVER_HANDLER_KEYS.some((k) => 'function' === typeof p[k]);
}

import { installRenderMeter } from './render-meter.js';

let installed = false;

/**
 * Wire up React support: the adapter for `reticle.inspect`, and the render meter.
 *
 * The meter used to be an export nobody called. `docs/usage.md` advertises
 * `reticle_state({ store: "__reticle_renders", path: "commits" })` for React commit counts, and the
 * store was never registered on any app — measured on two independent ones, `stores` listed only the
 * app's own. An agent asking for render counts got silence, indistinguishable from an idle page.
 *
 * It belongs here because this is the one function an app calls to say "I am React". Requiring a
 * second, separately-imported call for a documented capability is how a feature ships dead.
 */
export function install(): void {
  if (installed) return;
  installed = true;
  registerAdapter({ name: 'react', identify, readState, hasHoverHandlers });
  installRenderMeter();
}

export {
  installRenderMeter,
  resetRenderMeter,
  getRenderStats,
  type RenderStats,
} from './render-meter.js';
export {
  HYDRATION_COMPLETE_SIGNAL,
  createHydrationTracker,
  type HydrationTracker,
} from './hydration.js';
export {
  buildErrorBoundaryData,
  reticleOnCaughtError,
  type ErrorBoundaryData,
} from './error-boundary.js';
export {
  buildHydrationErrorData,
  isHydrationMismatch,
  reticleOnRecoverableError,
  type HydrationErrorData,
} from './hydration-error.js';
export { createCommitAggregator, type CommitAggregator } from './commit-aggregator.js';

// Zero-install component read: a self-contained fiber walker that runs INSIDE a page over CDP, for a
// page that never installed the SDK. react-devtools-mcp parity, reusing our own algorithm.
export {
  readComponentAt,
  buildReaderExpression,
  parseComponentRead,
  type CdpComponentRead,
} from './cdp-reader.js';

// This package IS the React kit: one install gives an app dev the full browser-side surface
// (the `reticle` instance + all sensing) plus this React adapter. Re-exporting the sensor here is
// what lets `reticle init` wire a single dependency (`@reticlehq/react`) instead of making the app
// name `@reticlehq/browser` too. `install` above is defined locally and takes precedence over any
// same-named star re-export (the browser package has none), so there is no collision.
export * from '@reticlehq/browser';
