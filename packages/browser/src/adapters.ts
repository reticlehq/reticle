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
}

const adapters: IrisAdapter[] = [];

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

export function adapterNames(): string[] {
  return adapters.map((a) => a.name);
}
