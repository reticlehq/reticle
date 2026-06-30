import { register } from './registry.js';
import type { SpecFn } from './types.js';

/** Public registration entry: `reticleTest('does X', async (t) => { ... })`. */
export function reticleTest(name: string, fn: SpecFn): void {
  register({ name, fn });
}
