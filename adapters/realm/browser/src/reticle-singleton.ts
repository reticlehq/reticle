import { Reticle } from './reticle.js';

/**
 * A leaf so nothing has to reach through the barrel to find it. `registry/emitter.ts` proxies to
 * this instance and is itself re-exported by the barrel, which made the package's entry point and
 * one of its smallest helpers need each other to load.
 *
 * The singleton embedded in the host app: `import { reticle } from '@reticlehq/browser'`.
 * Persisted on a global so HMR module re-evaluation reuses the same (already-connected)
 * instance instead of creating a second bridge connection (feedback #7).
 */
const globalStore = globalThis as unknown as { __reticleInstance?: Reticle };
export const reticle: Reticle = (globalStore.__reticleInstance ??= new Reticle());
