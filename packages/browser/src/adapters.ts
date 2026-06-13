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

export interface IrisAdapter {
  name: string;
  identify: (el: Element) => ComponentInfo | null;
  /** Best-effort: read a component's hook state for a DOM element (G2). */
  readState?: (el: Element) => unknown;
}

// Persist on a global so the registry survives HMR module re-evaluation (otherwise the
// adapter silently drops after a hot reload and source mapping degrades). See feedback #7.
const globalStore = globalThis as unknown as { __irisAdapters?: IrisAdapter[] };
const adapters: IrisAdapter[] = (globalStore.__irisAdapters ??= []);

/** Called by @iris/react (and future adapters) to register themselves. */
export function registerAdapter(adapter: IrisAdapter): void {
  if (!adapters.some((a) => a.name === adapter.name)) adapters.push(adapter);
}

/** First adapter that can identify the element wins. */
export function identifyComponent(el: Element): ComponentInfo | null {
  for (const adapter of adapters) {
    const info = adapter.identify(el);
    if (info !== null) return info;
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

export function adapterNames(): string[] {
  return adapters.map((a) => a.name);
}
