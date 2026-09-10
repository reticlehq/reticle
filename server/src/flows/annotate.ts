import {
  AnnotationErrorCode,
  AnnotationKind,
  AnnotationTarget,
  COMPILED_PREDICATE_PREFIX,
  flowExpectHasConsequence,
  flowExpectIsPresenceOnly,
  type Annotation,
  type AnnotateOutcome,
  type AnnotateResult,
  type FlowExpect,
} from '@reticlehq/core';

/**
 * The PURE compiler at the heart of the annotation facet. A structured annotation +
 * the current captured-step count → an AnnotateOutcome (a result envelope + the patch to apply to
 * the AnnotationStore). No IO, no clock, unit-testable in isolation.
 *
 * assert-signal → step.expect.signal (+ signalData) on the LAST step (needs ≥1 step)
 * assert-visible → step.expect.element.testid on the LAST step (needs ≥1 step)
 * mark-dynamic → flow.dynamic[] += testid flow-level, allowed with 0 steps
 * success-state → flow.success = { signal | element } flow-level (signal XOR testid; both → signal)
 *
 * FIRST CUT: only the four structured kinds above. Free natural-language annotation → predicate
 * compilation is explicitly FUTURE — an NL string never reaches here (AnnotationSchema
 * rejects it upstream; the tool maps that to UNKNOWN_KIND). No NL parser exists or is faked.
 */
export function compileAnnotation(a: Annotation, stepCount: number): AnnotateOutcome {
  switch (a.kind) {
    case AnnotationKind.ASSERT_SIGNAL: {
      if (0 === stepCount) return noStep();
      const expect: FlowExpect = { signal: a.name };
      if (a.dataMatches !== undefined) expect.signalData = a.dataMatches;
      return stepPatch(a, stepCount, expect);
    }
    case AnnotationKind.ASSERT_VISIBLE: {
      if (0 === stepCount) return noStep();
      return stepPatch(a, stepCount, { element: { testid: a.testid } });
    }
    case AnnotationKind.ASSERT_STATE: {
      if (0 === stepCount) return noStep();
      const state: FlowExpect['state'] = { path: a.statePath };
      if (a.store !== undefined) state.store = a.store;
      if (a.equals !== undefined) state.equals = a.equals;
      return stepPatch(a, stepCount, { state });
    }
    case AnnotationKind.ASSERT_NET: {
      if (0 === stepCount) return noStep();
      return stepPatch(a, stepCount, { net: a.net });
    }
    case AnnotationKind.MARK_DYNAMIC:
      return {
        result: { ok: true, target: AnnotationTarget.FLOW, compiled: describeCompiled(a) },
        patch: { dynamicAdd: a.testid },
      };
    case AnnotationKind.SUCCESS_STATE: {
      // Precedence: signal > state > net > console > testid (a consequence end-condition beats a
      // presence check). None of them → MISSING_FIELD.
      if (a.signal !== undefined) {
        return flowSuccess(a, { signal: a.signal });
      }
      if (a.statePath !== undefined) {
        const state: FlowExpect['state'] = { path: a.statePath };
        if (a.store !== undefined) state.store = a.store;
        if (a.equals !== undefined) state.equals = a.equals;
        if (a.hold !== undefined) state.hold = a.hold;
        return flowSuccess(a, { state });
      }
      if (a.net !== undefined) {
        return flowSuccess(a, { net: a.net });
      }
      if (a.console !== undefined) {
        return flowSuccess(a, { console: a.console });
      }
      if (a.testid !== undefined) {
        return flowSuccess(a, { element: { testid: a.testid } });
      }
      return { result: { ok: false, code: AnnotationErrorCode.MISSING_FIELD } };
    }
    case AnnotationKind.INTENT:
      // Flow-level, allowed with 0 steps (the business goal is declared up front).
      return {
        result: { ok: true, target: AnnotationTarget.FLOW, compiled: describeCompiled(a) },
        patch: { intent: a.text },
      };
  }
}

function noStep(): AnnotateOutcome {
  return { result: { ok: false, code: AnnotationErrorCode.NO_STEP_TO_ANNOTATE } };
}

function stepPatch(a: Annotation, stepCount: number, stepExpect: FlowExpect): AnnotateOutcome {
  return {
    result: {
      ok: true,
      target: AnnotationTarget.STEP,
      compiled: describeCompiled(a),
    },
    patch: { stepIndex: stepCount - 1, stepExpect },
  };
}

// A success end-condition that is not an observable CONSEQUENCE (signal / net / state) cannot lift
// the flow above the grade flow_save will give it. Saying "will succeed when ..." without that
// caveat is the #395 contradiction: annotate promises a check that flow_save then grades
// assertion-free, so a flow that only checks the console replays green through any regression. Name
// the grade here, using the same consequence/presence classification every grader shares.
const SUCCESS_ASSERTION_FREE_NOTE =
  'This success-state is not an observable consequence, so flow_save will grade the flow assertion-free — it passes even when the feature is broken. Use a signal / net / state success-state to give the flow something that can fail.';
const SUCCESS_PRESENCE_ONLY_NOTE =
  'This success-state only checks element presence, so flow_save will grade the flow presence-only — a locator healed to the wrong element still passes it. Use a signal / net / state success-state to assert an observable consequence.';

function flowSuccess(a: Annotation, success: FlowExpect): AnnotateOutcome {
  const result: AnnotateResult = {
    ok: true,
    target: AnnotationTarget.FLOW,
    compiled: describeCompiled(a),
  };
  if (!flowExpectHasConsequence(success)) {
    result.note = flowExpectIsPresenceOnly(success)
      ? SUCCESS_PRESENCE_ONLY_NOTE
      : SUCCESS_ASSERTION_FREE_NOTE;
  }
  return { result, patch: { success } };
}

/**
 * Human-readable confirmation text for the recorder strip / tool result,
 * e.g. `will assert signal diff:shown`. The leading word is the named COMPILED_PREDICATE_PREFIX.
 */
export function describeCompiled(a: Annotation): string {
  switch (a.kind) {
    case AnnotationKind.ASSERT_SIGNAL:
      return `${COMPILED_PREDICATE_PREFIX} assert signal ${a.name}`;
    case AnnotationKind.ASSERT_VISIBLE:
      return `${COMPILED_PREDICATE_PREFIX} assert ${a.testid} visible`;
    case AnnotationKind.ASSERT_STATE:
      return `${COMPILED_PREDICATE_PREFIX} assert state ${a.statePath}${
        a.equals !== undefined ? ` == ${JSON.stringify(a.equals)}` : ''
      }`;
    case AnnotationKind.ASSERT_NET: {
      // Say the COUNT out loud when there is one. "will assert POST /refund" and "will assert
      // exactly 1x POST /refund" are different gates, and the confirmation is the only place the
      // author sees which one they just attached.
      const what = `${a.net.method ?? 'any'} ${a.net.urlContains ?? '(any url)'}`;
      const times = a.net.count === undefined ? '' : ` exactly ${String(a.net.count)}x`;
      return `${COMPILED_PREDICATE_PREFIX} assert${times} request ${what}`;
    }
    case AnnotationKind.MARK_DYNAMIC:
      return `${COMPILED_PREDICATE_PREFIX} ignore ${a.testid} (dynamic)`;
    case AnnotationKind.SUCCESS_STATE:
      if (a.signal !== undefined) {
        return `${COMPILED_PREDICATE_PREFIX} succeed when signal ${a.signal}`;
      }
      if (a.statePath !== undefined) {
        return `${COMPILED_PREDICATE_PREFIX} succeed when state ${a.statePath}${
          a.equals !== undefined ? ` == ${JSON.stringify(a.equals)}` : ''
        }`;
      }
      if (a.net !== undefined) {
        const target = a.net.urlContains ?? a.net.method ?? 'request';
        return `${COMPILED_PREDICATE_PREFIX} succeed when ${
          a.net.count !== undefined ? `exactly ${String(a.net.count)} ` : ''
        }net ${target}`;
      }
      if (a.console !== undefined) {
        const level = a.console.level ?? 'error';
        return `${COMPILED_PREDICATE_PREFIX} succeed when ${
          true === a.console.absent ? `no console.${level}` : `console.${level}`
        }`;
      }
      return `${COMPILED_PREDICATE_PREFIX} succeed when ${a.testid ?? ''} visible`;
    case AnnotationKind.INTENT:
      return `${COMPILED_PREDICATE_PREFIX} intent: ${a.text}`;
  }
}
