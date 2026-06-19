import {
  AnnotationErrorCode,
  AnnotationKind,
  AnnotationTarget,
  COMPILED_PREDICATE_PREFIX,
  type Annotation,
  type AnnotateOutcome,
  type FlowExpect,
} from '@syrin/iris-protocol';

/**
 * The PURE compiler at the heart of the annotation facet. A structured annotation +
 * the current captured-step count → an AnnotateOutcome (a result envelope + the patch to apply to
 * the AnnotationStore). No IO, no clock, unit-testable in isolation.
 *
 *   assert-signal  → step.expect.signal (+ signalData)   on the LAST step (needs ≥1 step)
 *   assert-visible → step.expect.element.testid          on the LAST step (needs ≥1 step)
 *   mark-dynamic   → flow.dynamic[] += testid            flow-level, allowed with 0 steps
 *   success-state  → flow.success = { signal | element } flow-level (signal XOR testid; both → signal)
 *
 * FIRST CUT: only the four structured kinds above. Free natural-language annotation → predicate
 * compilation is explicitly FUTURE — an NL string never reaches here (AnnotationSchema
 * rejects it upstream; the tool maps that to UNKNOWN_KIND). No NL parser exists or is faked.
 */
export function compileAnnotation(a: Annotation, stepCount: number): AnnotateOutcome {
  switch (a.kind) {
    case AnnotationKind.ASSERT_SIGNAL: {
      if (stepCount === 0) return noStep();
      const expect: FlowExpect = { signal: a.name };
      if (a.dataMatches !== undefined) expect.signalData = a.dataMatches;
      return stepPatch(a, stepCount, expect);
    }
    case AnnotationKind.ASSERT_VISIBLE: {
      if (stepCount === 0) return noStep();
      return stepPatch(a, stepCount, { element: { testid: a.testid } });
    }
    case AnnotationKind.ASSERT_STATE: {
      if (stepCount === 0) return noStep();
      const state: FlowExpect['state'] = { path: a.statePath };
      if (a.store !== undefined) state.store = a.store;
      if (a.equals !== undefined) state.equals = a.equals;
      return stepPatch(a, stepCount, { state });
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

function flowSuccess(a: Annotation, success: FlowExpect): AnnotateOutcome {
  return {
    result: { ok: true, target: AnnotationTarget.FLOW, compiled: describeCompiled(a) },
    patch: { success },
  };
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
          a.console.absent === true ? `no console.${level}` : `console.${level}`
        }`;
      }
      return `${COMPILED_PREDICATE_PREFIX} succeed when ${a.testid ?? ''} visible`;
    case AnnotationKind.INTENT:
      return `${COMPILED_PREDICATE_PREFIX} intent: ${a.text}`;
  }
}
