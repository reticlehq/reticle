/**
 * `reticle_act_sequence` — several actions compiled into one round trip.
 *
 * Split out of `act-tools.ts` when that file passed the 1000-line backstop. A tool seam rather than
 * an arbitrary one: its two neighbours drive ONE action and grade its consequence, while this one
 * compiles a list of steps and runs them inside a single action window, reporting per step.
 *
 * It keeps its own `beginAction` — the dispatch and the attribution window that must wrap it stay in
 * the same file, which is the property `dispatch-attribution.test.ts` enforces. An earlier attempt
 * split the shared `actCommand` helper out instead, which separated the two and that guard caught it.
 */

import { z } from 'zod';
import { timeoutMsSchema } from './args/numeric-bounds.js';
import { compileSequenceStep } from '../../features/flows/replay.js';
import { ReticleTool } from '@reticlehq/core';
import { healthEnvelope } from '../../connection/session/session-health.js';
import {
  pausedShortCircuit,
  pausedOutputShape,
  withControl,
} from '../../connection/session/control-envelope.js';
import { asRecord } from '@reticlehq/core';
import { sessionIdFromArgs } from './tools-helpers.js';
import { describeStepResult, runStepWithStaleRetry } from './act/act-sequence-retry.js';
import { assertSequenceSteps } from './act/act-preflight.js';
import { type ToolDef, sessionIdShape } from './tool-kit.js';
import { actCommand } from './act-tools.js';
import {
  PredicateSchema,
  waitForPredicate,
} from '@reticlehq/engine/question/predicate/predicate.js';
import { DeviationMode, gradeSequence, type StepExpectation } from './act/sequence-grade.js';
import { stepEffect, type StepEffect } from '@reticlehq/engine/evidence/step-effect.js';
import type { Session } from '../../connection/session/session.js';
// resolveActTarget moved out of act-tools into its own module on this branch; #706 was written
// against the older layout where act-tools re-exported it.
import { resolveActTarget } from './act/act-target.js';

/**
 * The step's effect record, best-effort.
 *
 * An observation must never be able to fail the action it describes. This repo already states that
 * rule for progress reporters -- "a reporter must never be able to fail the thing it is reporting
 * on" -- and it holds harder here: a session shape without an event reader would otherwise throw
 * INSIDE the step loop, be caught as a step failure, and abort the rest of a journey that was
 * running perfectly. The drive is the product; the description of it is not.
 */
function effectOf(session: Session, since: number): StepEffect {
  try {
    return stepEffect(session.eventsSince(since), { since, until: session.elapsed() });
  } catch {
    return {};
  }
}

export const ACT_SEQUENCE_TOOL: ToolDef = {
  name: ReticleTool.ACT_SEQUENCE,
  // The example is required for a core tool, and this one carries weight: the measured loop it
  // replaces is literally a login form driven as three separate reticle_act calls (98 clicks and
  // 21 fills inside looping sessions, 2026-08-10/11). Showing fill -> fill -> click is showing the
  // exact shape an agent otherwise spends three round trips on.
  example: {
    steps: [
      { ref: 'e12', action: 'fill', args: { value: 'a@b.com' } },
      { ref: 'e13', action: 'fill', args: { value: 'hunter2' } },
      { ref: 'e14', action: 'click' },
    ],
  },
  description:
    'Run multiple actions in order (fill -> fill -> submit) in ONE round-trip. Prefer this over repeating reticle_act for a multi-step journey, then assert its consequence once. Returns per-step effects[] (see reticle_act).',
  inputSchema: {
    steps: z
      .array(z.record(z.unknown()))
      .describe(
        'Ordered list of { ref | target, action, args?, expect? } objects. Each step is equivalent to one reticle_act call — give `ref` from a snapshot/query, or `target` ({ testid } | { label } | { role, name } | { text }) to resolve in this call. Put confirmDangerous:true in a destructive step args object. `expect` is the same predicate shape as reticle_act_and_wait `until`, and it is what makes a step PROVE something: a step without one is driven, not verified, and the result says so. Naming the consequence is also FASTER — a named consequence is detected the instant it fires, where waiting for the page to settle can only conclude by waiting for silence.',
      ),
    onDeviation: z
      .enum([DeviationMode.HALT, DeviationMode.CONTINUE])
      .optional()
      .describe(
        'What to do when a step\'s `expect` does not hold. "halt" (default) stops there and returns the un-run tail — right for a dependent chain, where continuing past a broken login produces meaningless failures. "continue" drives every step and reports all misses — right for a sweep of independent controls.',
      ),
    timeout_ms: timeoutMsSchema
      .optional()
      .describe(
        'Per-step timeout in milliseconds. Default: 8000. Each step gets this budget independently.',
      ),
    ...sessionIdShape,
  },
  outputSchema: {
    since: z.number(),
    dispatched: z.boolean(),
    completed: z.number(),
    stalled_at: z.number().optional(),
    /** Index of the step whose declared consequence did not hold, when one did not. */
    stopped_at: z.number().optional(),
    /** THE field to gate on: "yes" | "no" | "unknown" — see `because`. */
    verified: z.string().optional(),
    because: z.string().optional(),
    /** How many steps declared a consequence, of how many were driven. Never averaged away. */
    coverage: z.object({ declared: z.number(), total: z.number() }).optional(),
    /** Steps never run, verbatim, so a caller re-plans the failure rather than the whole journey. */
    tail: z.array(z.record(z.unknown())).optional(),
    /**
     * Each step carries the same effect record a REPLAYED step carries: `window` (the
     * `reticle_observe { since, until }` drill address), `digest` (what the app did, as counts) and
     * `contradictions` (channels that disagree, present even when the step passed). Declared here
     * because an undeclared field is stripped from structuredContent and would be silently lost.
     */
    steps: z.array(z.record(z.unknown())).optional(),
    result: z.unknown().optional(),
    session: z
      .object({ lastSeenMs: z.number(), throttled: z.boolean(), focused: z.boolean() })
      .optional(),
    // Short-circuits to pausedShortCircuit while paused — declare its fields (drained-once guidance).
    ...pausedOutputShape,
  },
  handler: async (deps, args) => {
    const session = deps.sessions.resolve(sessionIdFromArgs(args));
    const paused = pausedShortCircuit(session);
    if (paused !== undefined) return paused;
    const since = session.elapsed();
    session.beginAction(ReticleTool.ACT_SEQUENCE, asRecord(args));
    try {
      const inputSteps = Array.isArray(args['steps']) ? args['steps'] : [];
      assertSequenceSteps(inputSteps);
      const perStepTimeout = 'number' === typeof args['timeout_ms'] ? args['timeout_ms'] : 8000;
      const stepResults: Record<string, unknown>[] = [];
      const expectations: StepExpectation[] = [];
      const onDeviation =
        DeviationMode.CONTINUE === args['onDeviation']
          ? DeviationMode.CONTINUE
          : DeviationMode.HALT;
      let stalledAt: number | undefined;
      let stoppedAt: number | undefined;

      // DIVERGENCE: live sends N individual ACT commands (for per-step timeout + progress);
      // replay sends one batched ACT_SEQUENCE command (flows/replay.ts:294). A bug in either is
      // invisible from the other — cover both when changing sequence semantics.
      for (let i = 0; i < inputSteps.length; i++) {
        const step = asRecord(inputSteps[i]);
        const stepSince = session.elapsed();
        try {
          // One retry when the ref went stale under a re-render — see act-sequence-retry.ts.
          // Resolve `target` with the same helper reticle_act uses, then dispatch by ref. Passing
          // the unresolved step through used to send `ref: undefined` and the browser blamed a
          // stale empty ref — the caller went looking for a re-render instead of a missing locator.
          const outcome = await runStepWithStaleRetry(
            async () => {
              const resolved = await resolveActTarget(session, step);
              if ('error' === resolved.kind) return { ok: false, error: resolved.message };
              return actCommand(
                deps,
                session,
                { ref: resolved.ref, action: step['action'], args: step['args'] ?? {} },
                perStepTimeout,
              );
            },
            session,
            since,
            perStepTimeout,
          );
          if (!outcome.ok) {
            stalledAt = i;
            stepResults.push({
              ref: step['ref'],
              action: step['action'],
              dispatched: false,
              error: outcome.error ?? 'step failed',
            });
            expectations.push({
              declared: undefined !== step['expect'],
              held: false,
              observed: outcome.error ?? 'the step could not be performed',
            });
            break;
          }
          /*
           * The SAME effect record a replayed step carries, from the same builder.
           *
           * A planned step driven now and the identical step replayed tomorrow have to describe what
           * happened in one vocabulary, or the before/after comparison this product exists for
           * cannot be read. Sharing the builder is what makes that true by construction rather than
           * by two implementations agreeing today.
           */
          const described = {
            ...describeStepResult(step, asRecord(outcome.result)),
            ...effectOf(session, stepSince),
          };
          /*
           * Evaluate what the step SAID it would cause, in the window this step opened.
           *
           * `stepSince` is taken before the dispatch so the predicate reads only this step's
           * consequences -- sharing the sequence's opening cursor would let step one's signal
           * satisfy step four's assertion, which is a false green built out of correct parts.
           */
          const parsed = PredicateSchema.safeParse(step['expect']);
          if (!parsed.success) {
            expectations.push({ declared: false });
            stepResults.push(described);
          } else {
            const verdict = await waitForPredicate(session, parsed.data, perStepTimeout, stepSince);
            const held = true === verdict.pass;
            expectations.push({
              declared: true,
              held,
              ...(verdict.observed === undefined ? {} : { observed: verdict.observed }),
              ...(verdict.expected === undefined ? {} : { expected: verdict.expected }),
            });
            stepResults.push({
              ...described,
              expected: verdict.expected ?? true,
              held,
              ...(held ? {} : { observed: verdict.observed ?? verdict.failureReason }),
            });
            if (!held) {
              stoppedAt ??= i;
              if (DeviationMode.HALT === onDeviation) break;
            }
          }
        } catch (err: unknown) {
          stalledAt = i;
          stepResults.push({
            ref: step['ref'],
            action: step['action'],
            dispatched: null,
            timedOut: true,
            error: err instanceof Error ? err.message : 'step timed out',
          });
          break;
        }
      }

      const completed = stalledAt ?? inputSteps.length;
      if (completed > 0) {
        session.lastAct.markActed(since, undefined, undefined);
      }
      if (deps.recordings.active().length > 0 && stalledAt === undefined) {
        deps.recordings.capture(
          compileSequenceStep(args, { count: inputSteps.length, steps: stepResults }),
        );
      }
      /*
       * The grade, and the coverage it is never allowed to hide.
       *
       * A plan of twelve steps where three declared a consequence and all three held is verified FOR
       * THOSE THREE and silent about nine. Reporting that as a pass is the arithmetic that buries the
       * nine, so `coverage` rides on every answer and `because` says it in words.
       */
      const grade = gradeSequence(expectations);
      const ran = stoppedAt ?? stalledAt ?? inputSteps.length;
      const tail = inputSteps.slice(ran + (stoppedAt === undefined ? 0 : 1));
      return withControl(session, {
        since,
        dispatched: completed > 0,
        completed,
        ...(stalledAt !== undefined ? { stalled_at: stalledAt } : {}),
        ...(stoppedAt !== undefined ? { stopped_at: stoppedAt } : {}),
        verified: grade.verified,
        because: grade.because,
        coverage: { declared: grade.declared, total: inputSteps.length },
        // Verbatim and unmodified: the steps after the break are usually still correct, and handing
        // them back edited invites a caller to re-plan work that was never wrong.
        ...(tail.length > 0 ? { tail: tail.map((raw) => asRecord(raw)) } : {}),
        steps: stepResults,
        ...healthEnvelope(session),
      });
    } finally {
      session.finishAction();
    }
  },
};
