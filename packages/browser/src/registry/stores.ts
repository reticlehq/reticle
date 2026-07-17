import { sanitizeForTransport } from '../security/serialization.js';

/** Store registry — lets the agent pull live framework/store state on demand. */
export type StoreGetter = () => unknown;

// Persist on a global so registrations survive HMR re-evaluation (see adapters.ts / feedback #7).
const globalStore = globalThis as unknown as { __reticleStores?: Map<string, StoreGetter> };
const stores: Map<string, StoreGetter> = (globalStore.__reticleStores ??= new Map());

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

/**
 * Read one store (by name) or all of them WITHOUT transport sanitization. For scoped reads that
 * select a sub-tree first, so a deep/large path (e.g. row 250 of a 500-row array) isn't truncated
 * before selection. Each getter is isolated: a throw becomes an error object.
 */
export function readStoresRaw(only?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, getter] of stores) {
    if (only !== undefined && name !== only) continue;
    try {
      out[name] = getter();
    } catch (error) {
      out[name] = { __error: error instanceof Error ? error.message : String(error) };
    }
  }
  return out;
}

/** Read one store (by name) or all of them, each capped for transport. */
export function readStores(only?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(readStoresRaw(only))) {
    out[name] = sanitizeForTransport(value);
  }
  return out;
}
