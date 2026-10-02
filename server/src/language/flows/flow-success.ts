/**
 * Evaluate a flow's `success` end-condition — "green means intent satisfied".
 *
 * This is the one piece replay does NOT do per-step: turn a flow's success FlowExpect into a
 * Predicate and assert it with the SAME waitForPredicate engine the tools/replay use. A signal/net
 * success is a real CONSEQUENCE — a locator healed to the wrong element cannot fake it, so it
 * catches the regression self-healing tools ship green (mabl/qate.ai). The dynamic skip-set is
 * honored exactly as in replay: a success bound to a dynamic (LLM-output) testid is presence-only,
 * never asserted, so the skip is symmetric across the step layer and the success layer.
 *
 * Lives in reticle-server (alongside the predicate engine) so BOTH the live MCP `reticle_flow_replay`
 * tool and the `@reticlehq/test` spec runner share one implementation — no divergent oracle.
 * Pure: no IO, no clock.
 */

import {
  AnchorKind,
  PredicateKind,
  clauseOfKind,
  flowExpectToPredicate,
  withoutClauses,
  type FlowExpect,
  type FlowFile,
  type Predicate,
} from '@reticlehq/core';
import type { EvalResult } from '@reticlehq/engine/question/predicate/predicate.js';
import type { FlowReplaySession, WaitForSignal } from './flow-replay-types.js';

/** The dynamic (LLM-output) testids whose presence is never asserted — same rule replay uses. */
export function dynamicTestids(flow: FlowFile): Set<string> {
  return new Set(
    (flow.dynamic ?? [])
      .filter((a) => a.kind === AnchorKind.TESTID)
      .map((a) => (a.kind === AnchorKind.TESTID ? a.value : '')),
  );
}

/** The synthetic step.tool a replay appends when it asserts the flow's success oracle. */
export const SUCCESS_STEP_TOOL = 'success';

/** A short human label for the success end-condition, for result rows. */
export function successLabel(success: Predicate | undefined): string {
  /*
   * NOT `expectLabel`, and the difference is the reader.
   *
   * That one names a clause for a drift row, where `signal:` tells you which channel failed. This
   * one is `mustHold` in the domain model an agent reads BEFORE testing — a list of what each flow
   * guarantees — and there the prefix is noise on the commonest case. A signal's own name is the
   * sentence: "order:placed" is what must hold.
   */
  const signal = clauseOfKind(success, PredicateKind.SIGNAL);
  if (signal?.name !== undefined) return signal.name;
  const net = clauseOfKind(success, PredicateKind.NET);
  if (net !== undefined) return net.urlContains ?? net.method ?? 'net';
  const console_ = clauseOfKind(success, PredicateKind.CONSOLE);
  if (console_ !== undefined) {
    return `console:${true === console_.absent ? 'clean' : (console_.level ?? 'error')}`;
  }
  const state = clauseOfKind(success, PredicateKind.STATE);
  if (state !== undefined) return `state:${state.path}`;
  const text = clauseOfKind(success, PredicateKind.TEXT);
  if (text?.contains !== undefined) return `text:${text.contains}`;
  const element = clauseOfKind(success, PredicateKind.ELEMENT);
  const q = element?.query;
  return q?.testid ?? q?.name ?? q?.role ?? 'success';
}

/**
 * What a flow's success oracle actually asserts, once the file has been read and the dynamic
 * (LLM-output) testids have been taken out of it.
 *
 * Most of what this function used to do is gone, and that is the migration working as intended: it
 * compiled a flat `FlowExpect` into a `Predicate`, and a step's `expect` IS a predicate now, lifted
 * by the schema when the file is read. It keeps the name and the signature because it is on
 * `@reticlehq/test`'s published surface, and it still accepts the flat shape for the same reason a
 * v1 file still loads — a spec written against the old spelling is not wrong, it is old.
 *
 * What remains is the DYNAMIC SKIP, and it is not cosmetic. A testid whose content a model writes is
 * asserted for PRESENCE by the step layer and never for content; a success oracle bound to one would
 * assert exactly what the flow has already declared unassertable. Dropping every such clause can
 * leave nothing at all, and `undefined` is the honest answer — vacuously met, the same as declaring
 * no success, because nothing here was checkable.
 */
export function successToPredicate(
  success: Predicate | FlowExpect | undefined,
  dynamic: ReadonlySet<string>,
): Predicate | undefined {
  if (success === undefined) return undefined;
  const predicate = 'kind' in success ? success : flowExpectToPredicate(success);
  if (predicate === undefined) return undefined;
  return withoutClauses(
    predicate,
    (clause) =>
      PredicateKind.ELEMENT === clause.kind &&
      clause.query.testid !== undefined &&
      dynamic.has(clause.query.testid),
  );
}

/**
 * Assert a flow's success end-condition after replay. Delegates to the injected waitForSignal (the
 * real waitForPredicate in production, a fake in unit tests). Passes when: no success was declared,
 * OR every success field was dynamic-skipped (vacuously met), OR the compiled predicate held within
 * the injected timeout. Never reads the wall clock.
 */
export async function assertSuccess(
  session: FlowReplaySession,
  success: Predicate | undefined,
  dynamic: ReadonlySet<string>,
  waitForSignal: WaitForSignal,
  timeoutMs: number,
  since = 0,
): Promise<EvalResult> {
  const predicate = successToPredicate(success, dynamic);
  if (predicate === undefined) return { pass: true };
  // `since` floors the window at the start of THIS replay so a success signal left in the buffer by
  // a prior replay/run (or, in heal, by the pre-heal drift replay) cannot fake a pass.
  return waitForSignal(session, predicate, timeoutMs, since);
}
