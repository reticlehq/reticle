import { registerAdapter, type ComponentInfo, type ComponentSource } from '@iris/browser';

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
}

const FIBER_PREFIXES = ['__reactFiber$', '__reactInternalInstance$'];
const MAX_DEPTH = 200;

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

let installed = false;

/** Register the React adapter so `iris.inspect` returns component stack + source file. */
export function install(): void {
  if (installed) return;
  installed = true;
  registerAdapter({ name: 'react', identify });
}
