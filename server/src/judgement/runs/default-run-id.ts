import { randomUUID } from 'node:crypto';
import { asRunId, type RunId } from '@reticlehq/core';

/**
 * The default run-id generator — a branded uuid.
 *
 * A leaf on purpose: `verification-sync.ts` wants this one function, and reaching it through the
 * flow-replay stack would be a cycle.
 */
export function defaultRunId(): RunId {
  return asRunId(randomUUID());
}
