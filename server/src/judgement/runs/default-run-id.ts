import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { asRunId, type RunId } from '@reticlehq/core';

/**
 * How many hex characters a new run id has: 64 bits.
 *
 * Each step screenshot path that an agent reads contains the run id, so a 36-character uuid cost
 * tokens on every action. 64 bits keeps a collision in one organisation's runs improbable. Old
 * uuid ids stay valid: a run id is any safe path segment, and nothing reads its shape.
 */
const RUN_ID_HEX = 16;

/**
 * The default run-id generator — 16 random hex characters.
 *
 * A leaf on purpose: `verification-sync.ts` wants this one function, and reaching it through the
 * flow-replay stack would be a cycle.
 */
export function defaultRunId(): RunId {
  return asRunId(randomBytes(RUN_ID_HEX / 2).toString('hex'));
}

/** A short id that is always the same for `key`, and always a safe path segment. */
export function stableRunId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, RUN_ID_HEX);
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
