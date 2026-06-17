import { sanitizeForTransport } from '../security/serialization.js';

/** Store registry — lets the agent pull live framework/store state on demand. */
export type StoreGetter = () => unknown;

// Persist on a global so registrations survive HMR re-evaluation (see adapters.ts / feedback #7).
const globalStore = globalThis as unknown as { __irisStores?: Map<string, StoreGetter> };
const stores: Map<string, StoreGetter> = (globalStore.__irisStores ??= new Map());

/** App calls this once per store: registerStore('workspace', () => useWorkspace.getState()). */
export function registerStore(name: string, getter: StoreGetter): void {
  stores.set(name, getter);
}

export function unregisterStore(name: string): void {
  stores.delete(name);
}

export function storeNames(): string[] {
  return [...stores.keys()];
}

/** Read one store (by name) or all of them. Each getter is isolated: a throw becomes an error string. */
export function readStores(only?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, getter] of stores) {
    if (only !== undefined && name !== only) continue;
    try {
      out[name] = sanitizeForTransport(getter());
    } catch (error) {
      out[name] = { __error: error instanceof Error ? error.message : String(error) };
    }
  }
  return out;
}
