/**
 * An `until` that was already true is refused BEFORE the action, and refused as the caller's mistake.
 *
 * A bare `{ kind: 'route' }` or `{ kind: 'state', path: '' }` is unconditionally true, so
 * `reticle_act_and_wait` dispatched, evaluated it, and returned `no-fault` with reason
 * `already_true` — a verdict-shaped object with nothing in it. Reported from the field: a driver
 * that generated those two as generic expectations got `already_true` on every verdict of two full
 * runs, and a flow recorded from such a drive passes even when the feature is broken.
 *
 * Two properties matter and they are separate. The refusal has to happen before the dispatch, so the
 * action is not spent on a question that could never be answered; and the error-recovery layer has
 * to recognise it as an invalid call, or the payload tells the agent its own bad predicate may be a
 * defect in Reticle worth a root-cause report.
 */
import { describe, expect, it } from 'vitest';
import { RefusalReason, PredicateKind } from '@reticlehq/core';
import { recoveryFor, refusalReasonFor } from '../error-recovery.js';
import { preflightAct } from './act-preflight.js';

const reasonOf = (until: unknown): string => {
  try {
    preflightAct({}, until);
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
};

describe('an already-true `until` is refused before the action', () => {
  it('refuses a bare route', () => {
    expect(() => preflightAct({}, { kind: PredicateKind.ROUTE })).toThrow('route');
  });

  it('refuses a state predicate with no path and nothing to compare', () => {
    expect(() => preflightAct({}, { kind: PredicateKind.STATE, path: '' })).toThrow('state');
  });

  it('lets a predicate that makes a real claim through', () => {
    expect(() =>
      preflightAct({}, { kind: PredicateKind.ROUTE, pathname: '/receipt' }),
    ).not.toThrow();
    expect(() => preflightAct({}, { kind: PredicateKind.SIGNAL })).not.toThrow();
    // The documented omit-`until` default. Refusing it here would break waiting for the page to
    // settle, which is the deterministic alternative to a sleep.
    expect(() => preflightAct({}, { kind: PredicateKind.SETTLED })).not.toThrow();
  });

  it('is rendered as the agent’s mistake, not as a possible Reticle defect', () => {
    const message = reasonOf({ kind: PredicateKind.ROUTE });
    expect(recoveryFor(message)).toBeDefined();
    expect(refusalReasonFor(message)).toBe(RefusalReason.BAD_ARGS);
  });
});
