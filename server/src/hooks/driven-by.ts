import { AsyncLocalStorage } from 'node:async_hooks';
import type { DrivenBy } from '@reticlehq/core';

/**
 * Which Harness drive the current tool call belongs to, carried across every await under it.
 *
 * The Harness dispatches through the same tools an agent calls, so nothing in a tool's arguments can
 * say who called it, and adding a field to every tool's schema would advertise it to every agent.
 * The context is set once around each Harness call and read where the journal writes the action.
 */
const current = new AsyncLocalStorage<DrivenBy>();

export function runDrivenBy<T>(by: DrivenBy, fn: () => Promise<T>): Promise<T> {
  return current.run(by, fn);
}

/** The Harness drive this call is part of, or undefined when the connected agent made it. */
export function currentDrivenBy(): DrivenBy | undefined {
  return current.getStore();
}
