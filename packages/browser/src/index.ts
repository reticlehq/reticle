import { Iris } from './iris.js';

/** The singleton embedded in the host app: `import { iris } from '@iris/browser'`. */
export const iris = new Iris();

export { Iris } from './iris.js';
export type { IrisConnectOptions } from './iris.js';

// Adapter API (used by @iris/react and other framework adapters).
export { registerAdapter, identifyComponent, adapterNames } from './adapters.js';
export type { IrisAdapter, ComponentInfo, ComponentSource } from './adapters.js';

// Lower-level building blocks (useful for tests and advanced embedding).
export { buildSnapshot } from './snapshot.js';
export { matchQuery, runQuery } from './query.js';
export { executeAction, executeSequence } from './actions.js';
export { describe, getRole, getAccessibleName, getStates, isVisible } from './a11y.js';
export { refs, RefRegistry } from './refs.js';
