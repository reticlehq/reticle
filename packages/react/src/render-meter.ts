/**
 * React render meter — counts commits the way React DevTools does, via the global
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot` callback (one call per committed render). This is
 * the Iris-only perf signal: Playwright/DevTools-MCP cannot observe a single React render, so a page
 * that is thrashing (committing many times a second) while the DOM stays visually identical — a
 * wasted-render storm — looks idle to them. Iris sees the commit rate.
 *
 * Exposed as a registered store (`__iris_renders`) so it reads through the normal `iris_state` path —
 * no new wire surface. Total commits is the robust, version-tolerant signal; we deliberately do NOT
 * attribute per-component (React clears the per-fiber work flags during commit, before this fires, so
 * a post-commit walk can't reliably tell which component re-rendered without the profiler build).
 *
 * HOST-SAFE BY CONSTRUCTION: everything is wrapped in try/catch and React itself guards its calls to
 * the devtools hook in try/catch, so a fault here can never break the host app's rendering. If a real
 * React DevTools hook is already present we AUGMENT it (call the original too); otherwise we install a
 * complete minimal hook. MUST be installed before `react-dom` initializes (React reads the hook at
 * renderer-inject time) — import this as the first side-effect in the app entry, before React.
 */
import { registerStore } from '@syrin/iris-browser';

const HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';
const RENDER_STORE = '__iris_renders';

interface DevtoolsHook {
  supportsFiber?: boolean;
  renderers?: Map<number, unknown>;
  inject?: (renderer: unknown) => number;
  onScheduleFiberRoot?: (...args: unknown[]) => void;
  onCommitFiberRoot?: (...args: unknown[]) => void;
  onPostCommitFiberRoot?: (...args: unknown[]) => void;
  onCommitFiberUnmount?: (...args: unknown[]) => void;
}

let commits = 0;
let installed = false;

function noop(): void {
  /* React calls these; a no-op keeps a freshly-installed hook complete. */
}

/** The render stats surfaced via the `__iris_renders` store (read with iris_state). */
export interface RenderStats {
  /** Total React commits observed since install (monotonic; diff over a window for a rate). */
  commits: number;
}

export function getRenderStats(): RenderStats {
  return { commits };
}

/** Reset the commit counter — call before a measured window so the count is window-scoped. */
export function resetRenderMeter(): void {
  commits = 0;
}

/**
 * Install (or augment) the React commit hook + register the `__iris_renders` store. Idempotent and
 * never throws. Call BEFORE react-dom loads.
 */
export function installRenderMeter(): void {
  if (installed) return;
  installed = true;
  try {
    const root = globalThis as unknown as Record<string, DevtoolsHook | undefined>;
    const existing = root[HOOK_KEY];
    if (existing === undefined) {
      root[HOOK_KEY] = {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        onScheduleFiberRoot: noop,
        onCommitFiberRoot: () => {
          commits += 1;
        },
        onPostCommitFiberRoot: noop,
        onCommitFiberUnmount: noop,
      };
    } else {
      const original =
        typeof existing.onCommitFiberRoot === 'function'
          ? existing.onCommitFiberRoot.bind(existing)
          : undefined;
      existing.onCommitFiberRoot = (...args: unknown[]) => {
        commits += 1;
        if (original !== undefined) {
          try {
            original(...args);
          } catch {
            /* a real DevTools hook faulting must not be our problem */
          }
        }
      };
    }
    registerStore(RENDER_STORE, () => getRenderStats());
  } catch {
    /* never break the host app */
  }
}
