import { randomUUID } from 'node:crypto';
import { asRunId, type RunId } from '@reticlehq/core';

/**
 * The default run-id generator — a branded uuid.
 *
 * A leaf on purpose. It used to live in `runner-port.ts`, which imports the whole flow-replay stack;
 * `verification-sync.ts` wanted this one function and got a cycle with it.
 */
export function defaultRunId(): RunId {
  return asRunId(randomUUID());
}
