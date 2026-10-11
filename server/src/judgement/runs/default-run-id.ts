import { AsyncLocalStorage } from 'node:async_hooks';
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

/**
 * The run a replay's step screenshots belong to, carried across every await under it.
 *
 * A suite's run id used to be minted after its flows had replayed, so a screenshot taken during a
 * step had no run to be filed under. The verify paths now mint the id first and run the replays
 * inside it; a capture outside any of them belongs to the session's own drive run.
 */
const current = new AsyncLocalStorage<string>();

export function withShotRun<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  return current.run(runId, fn);
}

/** The run being replayed now, or undefined outside a verify. */
export function currentShotRun(): string | undefined {
  return current.getStore();
}
