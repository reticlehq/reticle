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
 * Lives in iris-server (alongside the predicate engine) so BOTH the live MCP `iris_flow_replay`
 * tool and the `@syrin/iris-test` spec runner share one implementation — no divergent oracle.
 * Pure: no IO, no clock.
 */

import { AnchorKind, type FlowExpect, type FlowFile } from '@syrin/iris-protocol';
import type { EvalResult, Predicate } from '../events/predicate.js';
import type { FlowReplaySession, WaitForSignal } from './flow-replay.js';

/** The dynamic (LLM-output) testids whose presence is never asserted — same rule replay uses. */
export function dynamicTestids(flow: FlowFile): Set<string> {
  return new Set(
    (flow.dynamic ?? [])
      .filter((a) => a.kind === AnchorKind.TESTID)
      .map((a) => (a.kind === AnchorKind.TESTID ? a.value : '')),
  );
}

/** A short human label for the success end-condition, for result rows. */
export function successLabel(success: FlowExpect): string {
  if (success.signal !== undefined) return success.signal;
  if (success.net !== undefined) return success.net.urlContains ?? success.net.method ?? 'net';
  return success.element?.testid ?? success.element?.name ?? success.element?.role ?? 'success';
}

/** Compile a success FlowExpect into a predicate. undefined → nothing assertable (vacuously met). */
export function successToPredicate(
  success: FlowExpect,
  dynamic: ReadonlySet<string>,
): Predicate | undefined {
  const parts: Predicate[] = [];

  if (success.signal !== undefined) {
    parts.push(
      success.signalData !== undefined
        ? { kind: 'signal', name: success.signal, dataMatches: success.signalData }
        : { kind: 'signal', name: success.signal },
    );
  }

  if (success.net !== undefined) {
    const net: Extract<Predicate, { kind: 'net' }> = { kind: 'net' };
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
      if (Object.keys(query).length > 0) parts.push({ kind: 'element', query });
    }
  }

  const [first] = parts;
  if (parts.length === 0) return undefined;
  if (parts.length === 1 && first !== undefined) return first;
  return { kind: 'allOf', predicates: parts };
}

/**
 * Assert a flow's success end-condition after replay. Delegates to the injected waitForSignal (the
 * real waitForPredicate in production, a fake in unit tests). Passes when: no success was declared,
 * OR every success field was dynamic-skipped (vacuously met), OR the compiled predicate held within
 * the injected timeout. Never reads the wall clock.
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
