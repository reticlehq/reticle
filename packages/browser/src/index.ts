import { Iris } from './iris.js';

/**
 * The singleton embedded in the host app: `import { iris } from '@iris/browser'`.
 * Persisted on a global so HMR module re-evaluation reuses the same (already-connected)
 * instance instead of creating a second bridge connection (feedback #7).
 */
const globalStore = globalThis as unknown as { __irisInstance?: Iris };
export const iris: Iris = (globalStore.__irisInstance ??= new Iris());

export { Iris } from './iris.js';
export type { IrisConnectOptions } from './iris.js';

// Exclude your own dev widgets from snapshots/observers.
export { setIgnoreSelectors } from './dom-ignore.js';

// Adapter API (used by @iris/react and other framework adapters).
export {
  registerAdapter,
  identifyComponent,
  readComponentState,
  elementHasHoverHandlers,
  adapterNames,
} from './adapters.js';
export type { IrisAdapter, ComponentInfo, ComponentSource } from './adapters.js';

// Store registry (G2): pull live framework/store state on demand.
export { registerStore, unregisterStore, storeNames, readStores } from './stores.js';
export type { StoreGetter } from './stores.js';

// Capability registry (G5): the app self-describes its testable surface via iris.describe.
export { registerCapabilities, getCapabilities, hasCapabilities } from './capabilities.js';
export type { Capabilities, CapabilitiesInput, CapabilityFlow } from './capabilities.js';

// SDK helpers (P5): adopt the recommended integration patterns without boilerplate.
export { createIrisEmitter } from './emitter.js';
export type { IrisEmitter, EmitterTarget, CreateIrisEmitterOptions } from './emitter.js';
export { commitAndSignal } from './commit-and-signal.js';
export { registerIrisDomain } from './domains.js';
export type { IrisDomain } from './domains.js';

// Lower-level building blocks (useful for tests and advanced embedding).
export { buildSnapshot } from './snapshot.js';
export { matchQuery, runQuery } from './query.js';
export { executeAction, executeSequence } from './actions.js';
export { describe, getRole, getAccessibleName, getStates, isVisible } from './a11y.js';
export { refs, RefRegistry } from './refs.js';
