/**
 * P5b — pair a mutation with its signal so the two can't drift. The lighter alternative to a
 * Zustand middleware: one call runs the mutation, then emits the signal exactly once, and returns
 * the mutation's value. If `mutate` throws, the mutation never happened — so the signal is NOT
 * emitted and the error propagates unchanged (no try/finally, which would wrongly emit on throw).
 */

import type { IrisEmitter } from './emitter.js';

export function commitAndSignal<T>(
  emitter: IrisEmitter,
  mutate: () => T,
  name: string,
  data?: Record<string, unknown>,
): T {
  const result = mutate(); // throws here? then signal below is never reached — by design.
  emitter.signal(name, data);
  return result;
}
