import { register } from './registry.js';
import type { SpecFn } from './types.js';

/** Public registration entry: `irisTest('does X', async (t) => { ... })`. */
export function irisTest(name: string, fn: SpecFn): void {
  register({ name, fn });
}
