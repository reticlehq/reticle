import type { FlowExpect } from '@syrin/iris-protocol';
import type { EvalResult, FlowReplaySession, Predicate, WaitForSignal } from '@syrin/iris-server';
import { PredicateKind } from './constants.js';

/**
 * FLOW2SPEC — the one piece replay does NOT do: turn a flow's `success` FlowExpect into a server
 * Predicate so it can be asserted with the SAME waitForPredicate engine the tools/replay use. The
 * dynamic skip-set is honored here exactly as in replay: a success field bound to a dynamic
 * (LLM-output) testid is presence-only, never asserted — so the skip is symmetric across the step
 * layer and the success layer. Returns undefined when nothing assertable remains (success then
 * holds vacuously).
 */
export function successToPredicate(
  success: FlowExpect,
  dynamic: ReadonlySet<string>,
): Predicate | undefined {
  const parts: Predicate[] = [];

  if (success.signal !== undefined) {
    parts.push(
      success.signalData !== undefined
        ? { kind: PredicateKind.SIGNAL, name: success.signal, dataMatches: success.signalData }
        : { kind: PredicateKind.SIGNAL, name: success.signal },
    );
  }

  if (success.net !== undefined) {
    const net: Extract<Predicate, { kind: 'net' }> = { kind: PredicateKind.NET };
    if (success.net.method !== undefined) net.method = success.net.method;
    if (success.net.urlContains !== undefined) net.urlContains = success.net.urlContains;
    if (success.net.status !== undefined) net.status = success.net.status;
    parts.push(net);
  }

  const element = success.element;
  if (element !== undefined) {
    const testid = element.testid;
    // A dynamic-marked testid is NOT asserted as a success condition (presence-only).
    if (testid === undefined || !dynamic.has(testid)) {
      const query: Record<string, string> = {};
      if (testid !== undefined) query['testid'] = testid;
      if (element.role !== undefined) query['role'] = element.role;
      if (element.name !== undefined) query['name'] = element.name;
      if (Object.keys(query).length > 0) {
        parts.push({ kind: PredicateKind.ELEMENT, query });
      }
    }
  }

  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return { kind: 'allOf', predicates: parts };
}

/**
 * FLOW2SPEC — assert a flow's success end-condition after replay. Delegates evaluation to the
 * injected waitForSignal (the real waitForPredicate in CI, a fake in unit tests). Passes when:
 * no success was declared, OR every success field was dynamic-skipped (vacuously met), OR the
 * compiled predicate held within the injected timeout. Never reads the wall clock.
 */
export async function assertSuccess(
  session: FlowReplaySession,
  success: FlowExpect | undefined,
  dynamic: ReadonlySet<string>,
  waitForSignal: WaitForSignal,
  timeoutMs: number,
): Promise<EvalResult> {
  if (success === undefined) return { pass: true };
  const predicate = successToPredicate(success, dynamic);
  if (predicate === undefined) return { pass: true };
  return waitForSignal(session, predicate, timeoutMs);
}
