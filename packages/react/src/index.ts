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
  let source: ComponentSource | undefined;
  let depth = 0;

  while (fiber !== null && depth < MAX_DEPTH) {
    depth += 1;
    const name = componentName(fiber.elementType ?? fiber.type);
    if (name !== null && stack[stack.length - 1] !== name) stack.push(name);
    if (source === undefined && fiber._debugSource !== undefined) {
      source = { file: fiber._debugSource.fileName, line: fiber._debugSource.lineNumber };
      if (fiber._debugSource.columnNumber !== undefined) {
        source.column = fiber._debugSource.columnNumber;
      }
    }
    fiber = fiber.return;
  }

  if (stack.length === 0 && source === undefined) return null;
  const info: ComponentInfo = { componentStack: stack };
  if (source !== undefined) info.source = source;
  return info;
}

let installed = false;

/** Register the React adapter so `iris.inspect` returns component stack + source file. */
export function install(): void {
  if (installed) return;
  installed = true;
  registerAdapter({ name: 'react', identify });
}
