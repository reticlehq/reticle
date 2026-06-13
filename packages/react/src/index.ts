import { registerAdapter, type ComponentInfo, type ComponentSource } from '@iris/browser';
import { ComponentStateReason, type ComponentStateResult } from '@iris/protocol';

interface Hook {
  memoizedState: unknown;
  next: Hook | null;
}

/** Minimal shape of the React fiber fields we read. */
interface DebugSource {
  fileName: string;
  lineNumber: number;
  columnNumber?: number;
}
interface Fiber {
  return: Fiber | null;
  type: unknown;
  elementType: unknown;
  _debugSource?: DebugSource;
  memoizedState?: unknown; // for a function component this is the head of the hook list
  memoizedProps?: unknown; // host fiber props incl. JSX event handlers
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
const FRAMEWORK_NOISE =
  /(Context|Boundary|Provider|Router|Handler)$|^(Root|ServerRoot|HotReload|Fragment|__next)/;

function isFrameworkNoise(name: string): boolean {
  return FRAMEWORK_NOISE.test(name);
}

function getFiber(el: Element): Fiber | null {
  const key = Object.keys(el).find((k) => FIBER_PREFIXES.some((p) => k.startsWith(p)));
  if (key === undefined) return null;
  const value = (el as unknown as Record<string, unknown>)[key];
  return (value ?? null) as Fiber | null;
}

/** Display name of a component type (function, forwardRef/memo object, or host string). */
function componentName(type: unknown): string | null {
  if (typeof type === 'function') {
    const fn = type as { displayName?: string; name?: string };
    if (fn.displayName !== undefined && fn.displayName.length > 0) return fn.displayName;
    return fn.name !== undefined && fn.name.length > 0 ? fn.name : null;
  }
  if (typeof type === 'object' && type !== null) {
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
    if (source === undefined && fiber._debugSource !== undefined) {
      source = { file: fiber._debugSource.fileName, line: fiber._debugSource.lineNumber };
      if (fiber._debugSource.columnNumber !== undefined) {
        source.column = fiber._debugSource.columnNumber;
      }
    }
    fiber = fiber.return;
  }

  // React 19 dropped `_debugSource`; fall back to a data-iris-source stamp if present
  // (added by @iris/babel-plugin in dev).
  if (source === undefined) {
    source = sourceFromAttribute(el);
  }

  // Prefer the de-noised stack; fall back to the nearest raw name if filtering left nothing.
  const componentStack = stack.length > 0 ? stack : rawStack.slice(0, 1);
  if (componentStack.length === 0 && source === undefined) return null;
  const info: ComponentInfo = { componentStack };
  if (source !== undefined) info.source = source;
  return info;
}

function sourceFromAttribute(el: Element): ComponentSource | undefined {
  const stamped = el.closest('[data-iris-source]');
  const raw = stamped?.getAttribute('data-iris-source');
  if (raw === null || raw === undefined) return undefined;
  const match = /^(.*):(\d+):(\d+)$/.exec(raw);
  if (match === null) return undefined;
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
    if (typeof fiber.type === 'function' || typeof fiber.elementType === 'function') return fiber;
    fiber = fiber.return;
  }
  return null;
}

/**
 * JSON-safe projection of an arbitrary hook value (F5). Drops functions/DOM nodes/cycles and
 * bounds depth/breadth, so the result handed to `JSON.stringify` downstream can never throw.
 * Raw hook states routinely hold `useRef` DOM nodes, dispatchers, and circular fiber backrefs —
 * serializing those un-guarded is the F5 hang. Never throws.
 */
function safeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') return null;
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
 * structured `{ ok: false, reason }` (F5) rather than throwing or producing an unserializable value.
 */
/** Build a success result, omitting `component` when the name is unknown (exactOptional-safe). */
function ok(name: string | null, hooks: unknown[]): ComponentStateResult {
  return name === null ? { ok: true, hooks } : { ok: true, component: name, hooks };
}

export function readState(el: Element): ComponentStateResult {
  try {
    const fiber = nearestComponentFiber(el);
    if (fiber === null) {
      return { ok: false, reason: ComponentStateReason.UNAVAILABLE };
    }
    const name = componentName(fiber.elementType ?? fiber.type);
    const head = fiber.memoizedState;
    if (typeof head !== 'object' || head === null) {
      return ok(name, []);
    }
    const hooks: unknown[] = [];
    const seen = new WeakSet<object>();
    let hook = head as Hook;
    let i = 0;
    while (typeof hook === 'object' && i < MAX_HOOKS) {
      hooks.push(safeValue(hook.memoizedState, 0, seen));
      const next = hook.next;
      if (next === null || typeof next !== 'object') break;
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
 * F3: true if the element's host fiber declares React enter/leave handlers. Synthetic dispatchEvent
 * does not reliably trigger React's native enter/leave synthesis (no hit-testing), so callers warn.
 * Fail soft: any unexpected fiber shape returns false.
 */
export function hasHoverHandlers(el: Element): boolean {
  const fiber = getFiber(el);
  const props = fiber?.memoizedProps;
  if (typeof props !== 'object' || props === null) return false;
  const p = props as Record<string, unknown>;
  return HOVER_HANDLER_KEYS.some((k) => typeof p[k] === 'function');
}

let installed = false;

/** Register the React adapter so `iris.inspect` returns component stack + source file. */
export function install(): void {
  if (installed) return;
  installed = true;
  registerAdapter({ name: 'react', identify, readState, hasHoverHandlers });
}
