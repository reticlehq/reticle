import { AsyncLocalStorage } from 'node:async_hooks';
import { outwardActionsAsked, type DrivenBy, type OutwardAction } from '@reticlehq/core';

/**
 * Which Harness drive the current tool call belongs to, carried across every await under it.
 *
 * The Harness dispatches through the same tools an agent calls, so nothing in a tool's arguments can
 * say who called it, and adding a field to every tool's schema would advertise it to every agent.
 * The context is set once around each Harness call and read where the journal writes the action.
 */
const current = new AsyncLocalStorage<DrivenBy>();

export function runDrivenBy<T>(
  by: DrivenBy,
  fn: () => Promise<T>,
  /** What the PERSON asked for, in their own words: the only text that allows an outward action. */
  asked?: string,
): Promise<T> {
  return current.run(by, () => (asked === undefined ? fn() : askedStore.run(asked, fn)));
}

/** The person's own request for the Harness drive running now, when they made one. */
const askedStore = new AsyncLocalStorage<string>();

/** The Harness drive this call is part of, or undefined when the connected agent made it. */
export function currentDrivenBy(): DrivenBy | undefined {
  return current.getStore();
}

/**
 * Bind a callback to the Harness drive running NOW, so it is still the Harness's when it fires later.
 *
 * A wait re-checks its predicate from a page-event listener and a timer, outside the awaited chain,
 * where this context does not reach. Those re-checks went to the page untagged and the HUD filed the
 * Harness's own "Finding…" rows in the Agent Log. Returns `fn` unchanged outside a drive.
 */
export function bindDrivenBy<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  const by = current.getStore();
  if (by === undefined) return fn;
  return (...args: A): void => {
    current.run(by, () => fn(...args));
  };
}

/** Set while a SAVED flow replays: its steps were asked for by whoever recorded them. */
const savedFlow = new AsyncLocalStorage<true>();

/** Replay a saved flow: its outward steps are the journey, not a model's choice. */
export function runSavedFlow<T>(fn: () => Promise<T>): Promise<T> {
  return savedFlow.run(true, fn);
}

/**
 * The outward actions (invite, send, delete, pay…) this call may take, or undefined when it is not
 * gated: an agent's call, or a saved flow's step. A Harness call a model or a planner chose may take
 * only what its journey asks for in so many words — the Harness pressed Invite in a customer's
 * workspace when its journey said "she does not send an invite".
 */
export function harnessOutwardAllowed(): OutwardAction[] | undefined {
  const by = current.getStore();
  if (by === undefined || true === savedFlow.getStore()) return undefined;
  // The person's words, never a planner's: a plan the platform invented ("press Invite") is not a
  // request anybody made.
  return outwardActionsAsked(askedStore.getStore() ?? '');
}
