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
import { compileSequenceStep, pathOf, wroteSince } from '@/language/flows/replay.js';
import { DEFAULT_SEQUENCE_STEP_TIMEOUT_MS } from '@/language/flows/flow-step-runners.js';
import { sequenceStepArgs } from './act/act-preflight.js';
import {
  REPLAY_PROGRAM_VERSION,
  ReticleTool,
  Verified,
  VerifiedReason,
  type JournalVerdictEffect,
  checkIntent,
} from '@reticlehq/core';
import type { RecordedStep } from '@/language/flows/recording/tape/recordings.js';
import { healthEnvelope } from '@/portal/session/session-health.js';
import {
  pausedShortCircuit,
  pausedOutputShape,
  withControl,
} from '@/portal/session/control-envelope.js';
import { asRecord, isAbsenceDerived, isAdvisory } from '@reticlehq/core';
import { sessionIdFromArgs } from './tools-helpers.js';
import { describeStepResult, runStepWithStaleRetry } from './act/act-sequence-retry.js';
import { assertSequenceSteps } from './act/act-preflight.js';
import { EnvelopeKey, type ToolDef, sessionIdShape } from './tool-kit.js';
import { takeStepShot } from '@/features/visual/step-shots.js';
import { actCommand } from './act-tools.js';
import {
  PredicateSchema,
  waitForPredicate,
  type Predicate,
} from '@reticlehq/engine/question/predicate/predicate.js';
import {
  DeviationMode,
  gradeSequence,
  JOURNEY_RECORDING,
  offerToKeep,
  type StepExpectation,
} from './act/sequence-grade.js';
import { stepEffect, appScope, type StepEffect } from '@reticlehq/engine/evidence/step-effect.js';
import type { Session } from '@/portal/session/session.js';
// resolveActTarget moved out of act-tools into its own module on this branch; #706 was written
// against the older layout where act-tools re-exported it.
import { resolveActTarget } from './act/act-target.js';
import { gradeOfPredicate } from './assert/assert-grade.js';
import { describeWaitTarget } from '@reticlehq/engine/evidence/unsettled.js';
import { sourceOf } from './tools-helpers.js';
import { confirmedByDeclaration } from './act/act-danger.js';
import { unreachableTargetNote } from './act/act-observation.js';

/**
 * The step's effect record, best-effort.
 *
 * An observation must never be able to fail the action it describes. This repo already states that
 * rule for progress reporters -- "a reporter must never be able to fail the thing it is reporting
 * on" -- and it holds harder here: a session shape without an event reader would otherwise throw
 * INSIDE the step loop, be caught as a step failure, and abort the rest of a journey that was
 * running perfectly. The drive is the product; the description of it is not.
 */
function effectOf(session: Session, since: number, expect: unknown): StepEffect {
  try {
    // A failure the step declared is its expected result, as it is for `act_and_wait`'s `until`.
    const declared = PredicateSchema.safeParse(expect);
    return stepEffect(
      session.eventsSince(since),
      { since, until: session.elapsed() },
      { ...appScope(session), ...(declared.success ? { declared: [declared.data] } : {}) },
    );
  } catch {
    return {};
  }
}

/**
 * A journey step's declared consequence, as the check the session journal keeps.
 *
 * `reticle_act { steps }` graded every `expect` and journaled none of them: the journal action for
 * the whole journey carried no verdict effect, so `reticle_session { end }` folded "nothing was
 * checked", and no run reached `.reticle/runs/` or the dashboard — a failed check lost from the
 * record on the path the instructions call the default. Each evaluated `expect` is now one check,
 * written in the same shape `reticle_act_and_wait` writes, so every fold reads it the same way.
 */
interface StepCheck {
  readonly expect: Predicate;
  readonly held: boolean;
  /** The page went away (or the predicate could not be read) before the consequence was decided. */
  readonly undecided: boolean;
  /** Undecided because no person could have made the click, not because the page went away. */
  readonly unreachable?: boolean;
  /** Deciding contradiction kinds seen in the step's window. */
  readonly contradicted: readonly string[];
  readonly expected?: string | undefined;
  readonly observed?: string | undefined;
  /** The step result's `source`, as the browser reported it. */
  readonly source?: unknown;
  /** What the evaluation kept: an allOf's per-part results name the part that failed. */
  readonly evidence?: unknown;
  /** The verdict's assertion: whether a net claim's call was made at all. */
  readonly assertion?: string | undefined;
}

/** The verdict effect for one step: the same rules act_and_wait applies to one action. */
function stepVerdictEffect(check: StepCheck): JournalVerdictEffect {
  const { verified, reason } = check.held
    ? 0 < check.contradicted.length
      ? { verified: Verified.NO, reason: VerifiedReason.CONTRADICTED }
      : { verified: Verified.YES, reason: undefined }
    : check.undecided
      ? {
          verified: Verified.UNKNOWN,
          reason:
            true === check.unreachable
              ? VerifiedReason.INCONCLUSIVE
              : VerifiedReason.OBSERVATION_LOST,
        }
      : { verified: Verified.NO, reason: VerifiedReason.ASSERTION_FAILED };
  const source = sourceOf(check.source);
  return {
    claim: describeWaitTarget(check.expect),
    verified,
    // A step's sentence: the step names no intent of its own, so it is built from its expect.
    ...checkIntent(check.expect, check),
    ...(source === undefined ? {} : { source: `${source.file}:${String(source.line)}` }),
    ...(check.expected === undefined ? {} : { expected: check.expected }),
    ...(check.observed === undefined ? {} : { observed: check.observed }),
    // Named in the step before the step ran — a check, not a rationalisation.
    declaredBeforeActing: true,
    grade: gradeOfPredicate(check.expect),
    kind: check.expect.kind,
    ...(reason === undefined ? {} : { reason }),
  };
}

/** One step's check, journaled best-effort: the record must never fail the drive it records. */
function journalStep(session: Session, args: Record<string, unknown>, effect: unknown): void {
  try {
    session.recordAction(ReticleTool.ACT_SEQUENCE, args, effect);
  } catch {
    // ponytail: a session without a journal (a test double, journaling off) keeps no check.
  }
}

/**
 * Ceiling for a burst gap. Past this it is not a burst, it is a paced walk.
 *
 * HOW TO PICK A GAP, because both edges are real and neither is guessable. It must outlast the
 * handler committing and dispatching its request, and undercut the response it is racing.
 * Measured against a superseded-filter race (the superseded query 700ms, the one replacing it 90ms):
 * at 0ms the first request was never issued at all, and at the ordinary settle (~500ms in a
 * throttled tab, where rAF never fires and the frame budget always times out) the two clicks
 * serialised and never overlapped. 50ms sat in the window. A different app needs a different
 * number: read its own slow endpoint.
 */
const BURST_MAX_GAP_MS = 500;

/** A step error that means nothing was acted on, or the page went away with the observation. */
const UNJUDGED_STEP =
  /matched no element|no longer resolves|session disconnected|session (was )?replaced/i;

export const ACT_SEQUENCE_TOOL: ToolDef = {
  name: ReticleTool.ACT_SEQUENCE,
  // The example is required for a core tool, and this one carries weight: the loop it replaces is
  // a login form driven as three separate reticle_act calls. Showing fill -> fill -> click is showing
  // the exact shape an agent otherwise spends three round trips on.
  example: {
    steps: [
      { ref: 'e12', action: 'fill', args: { value: 'a@b.com' } },
      { ref: 'e13', action: 'fill', args: { value: 'hunter2' } },
      { ref: 'e14', action: 'click' },
    ],
  },
  description:
    "Drive a WHOLE journey in ONE round-trip, with NO snapshot first. Name each step's element by {testid} | {label} | {role,name} | {text} in `target` and Reticle resolves it AT THE MOMENT THAT STEP RUNS — so a control that does not exist yet (a modal an earlier step opens, a row it creates) is still addressable, and waits up to timeout_ms to appear. This is the fast path: snapshot -> act -> snapshot -> act costs a model turn per step and is the slowest thing an agent can do. Give each step an `expect` and the sequence stops at the first one that does not hold, returning the un-run `tail` verbatim so you re-plan only the failure. Returns per-step effects[] (see reticle_act).",
  inputSchema: {
    steps: z
      .array(z.record(z.string(), z.unknown()))
      .describe(
        'Ordered list of { ref | target, action, args?, expect? } objects. Each step is equivalent to one reticle_act call, and takes its arguments either way: `{ ref, action: "fill", value: "…" }` flat, as reticle_act does, or nested as `args: { value }`. Give `ref` from a snapshot/query, or `target` ({ testid } | { label } | { role, name } | { text }) to resolve in this call. Put confirmDangerous:true in a destructive step args object. `expect` is the same predicate shape as reticle_act_and_wait `until`, and it is what makes a step PROVE something: a step without one is driven, not verified, and the result says so. Naming the consequence is also FASTER — a named consequence is detected the instant it fires, where waiting for the page to settle can only conclude by waiting for silence.',
      ),
    // A plain number, not boolean|number: a zod union serialises to a JSON-Schema `anyOf` that
    // cost 174 B on a surface re-sent every turn, against 81 B of headroom. One spelling is also
    // the better API — `burst: 50` says what it does, where `burst: true` hides a magic default.
    burst: z
      .number()
      .min(0)
      .max(BURST_MAX_GAP_MS)
      .optional()
      .describe('ms gap between dispatches, to provoke an ordering race (try 50). Omit to settle.'),
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
    /** Number of steps included in the saved recording, when a recording was created. */
    recorded: z.number(),
    stalled_at: z.number().optional(),
    /** Index of the step whose declared consequence did not hold, when one did not. */
    stopped_at: z.number().optional(),
    /** THE field to gate on: "yes" | "no" | "unknown" — see `because`. */
    verified: z.string().optional(),
    because: z.string().optional(),
    /**
     * Present only when the plan PROVED something — see `offerToKeep`. A plan that declared nothing
     * replays green whatever the app does, so offering to keep it would manufacture regression
     * coverage that cannot go red.
     */
    keep: z.string().optional(),
    /** How many steps declared a consequence, of how many were driven. Never averaged away. */
    coverage: z.object({ declared: z.number(), total: z.number() }).optional(),
    /** Steps never run, verbatim, so a caller re-plans the failure rather than the whole journey. */
    tail: z.array(z.record(z.string(), z.unknown())).optional(),
    /**
     * Each step carries the same effect record a REPLAYED step carries: `window` (the
     * `reticle_observe { since, until }` drill address), `digest` (what the app did, as counts) and
     * `contradictions` (channels that disagree, present even when the step passed). Declared here
     * because an undeclared field is stripped from structuredContent and would be silently lost.
     */
    steps: z.array(z.record(z.string(), z.unknown())).optional(),
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
    const pageBefore = pathOf(session.url);
    session.beginAction(ReticleTool.ACT_SEQUENCE, asRecord(args));
    try {
      const inputSteps = Array.isArray(args['steps']) ? args['steps'] : [];
      assertSequenceSteps(inputSteps);
      const perStepTimeout =
        'number' === typeof args['timeout_ms']
          ? args['timeout_ms']
          : DEFAULT_SEQUENCE_STEP_TIMEOUT_MS;
      const stepResults: Record<string, unknown>[] = [];
      // Every step leaves a picture of the page as its outcome was decided — see step-shots.ts.
      const pushStep = async (row: Record<string, unknown>): Promise<void> => {
        stepResults.push({
          ...row,
          [EnvelopeKey.SCREENSHOT]: await takeStepShot(deps, session.id, ReticleTool.ACT),
        });
      };
      const expectations: StepExpectation[] = [];
      // `true` means the default window; a number means that window exactly. 0 is legal and means
      // "no settle at all" — useful only when the app issues its request synchronously.
      const burstArg = args['burst'];
      const burstGapMs =
        // The schema declares the same bounds, so this clamp is belt-and-braces — it matters for
        // the replay path, which reaches this handler without the advertised schema in front of it.
        'number' === typeof burstArg && Number.isFinite(burstArg)
          ? Math.max(0, Math.min(burstArg, BURST_MAX_GAP_MS))
          : undefined;
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
              const resolved = await resolveActTarget(session, step, perStepTimeout);
              if ('error' === resolved.kind) return { ok: false, error: resolved.message };
              // In burst mode every step carries a zero settle budget, so step N+1 is dispatched
              // while step N is still in flight. That overlap IS the test — see `burst` above.
              return actCommand(
                deps,
                session,
                {
                  ref: resolved.ref,
                  action: step['action'],
                  // `sequenceStepArgs` reads a step's arguments flat OR nested — keep it, it is the
                  // fix for `{ ref, action: "fill", value }` silently losing `value`. Burst only
                  // LAYERS on top: return as soon as the dispatch is in, because the gap below, not
                  // the settle, is what paces the sequence. Leaving the default settle here would
                  // race rAF and return early anyway — a budget is a CEILING, not a floor, which is
                  // why an earlier attempt to pace with `settleMs` alone produced a 12ms step and
                  // no race at all.
                  // A step that names its dangerous control and declares its consequence is
                  // confirmed by that declaration, as act_and_wait is — see confirmedByDeclaration.
                  args: ((stepArgs) =>
                    burstGapMs === undefined ? stepArgs : { ...stepArgs, settleMs: 0 })(
                    confirmedByDeclaration(
                      sequenceStepArgs(step),
                      step['target'],
                      step['expect'] !== undefined,
                    ),
                  ),
                },
                perStepTimeout,
              );
            },
            session,
            since,
            perStepTimeout,
          );
          // Hold the gap BEFORE the next dispatch, measured from this step's own start so the
          // pacing is the interval between ACTIONS, not the interval plus however long this step
          // happened to take. The last step needs no gap: nothing follows it to race.
          if (burstGapMs !== undefined && i < inputSteps.length - 1) {
            const elapsed = session.elapsed() - stepSince;
            const remaining = burstGapMs - elapsed;
            if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
          }
          if (!outcome.ok) {
            stalledAt = i;
            await pushStep({
              ref: step['ref'],
              action: step['action'],
              dispatched: false,
              error: outcome.error ?? 'step failed',
            });
            const error = outcome.error ?? 'the step could not be performed';
            expectations.push({
              declared: undefined !== step['expect'],
              held: false,
              observed: error,
              // Nothing acted on, or the page gone with the observation: undecided, not a miss.
              ...(UNJUDGED_STEP.test(error) ? { undecided: error } : {}),
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
          const describe = () => ({
            ...describeStepResult(step, asRecord(outcome.result)),
            ...effectOf(session, stepSince, step['expect']),
          });
          const deciding = (step: ReturnType<typeof describe>) =>
            (step.contradictions ?? [])
              .map((c) => c.kind)
              .filter((kind) => !isAdvisory(kind) && !isAbsenceDerived(kind));
          /*
           * Evaluate what the step SAID it would cause, in the window this step opened.
           *
           * `stepSince` is taken before the dispatch so the predicate reads only this step's
           * consequences -- sharing the sequence's opening cursor would let step one's signal
           * satisfy step four's assertion, which is a false green built out of correct parts.
           */
          const parsed = PredicateSchema.safeParse(step['expect']);
          // A click no person could have made decides nothing, whatever followed it.
          const unreachable = unreachableTargetNote(outcome.result);
          if (!parsed.success) {
            const described = describe();
            const contradicted = deciding(described);
            expectations.push({
              declared: false,
              ...(0 === contradicted.length ? {} : { contradicted }),
              ...(unreachable === undefined ? {} : { undecided: unreachable }),
            });
            await pushStep(described);
          } else {
            const verdict = await waitForPredicate(session, parsed.data, perStepTimeout, stepSince);
            // Described over the window the verdict was taken in, not the dispatch window before it:
            // a step that waited 1.5s for its declared 200 reported that request "still in flight"
            // beside `held: true`, a contradiction about a moment the verdict was not taken at.
            const described = describe();
            const contradicted = deciding(described);
            const disagreement = 0 === contradicted.length ? {} : { contradicted };
            const held = true === verdict.pass && unreachable === undefined;
            // A tab that went away (an external checkout page) or a predicate that could not be
            // read decided nothing: unknown, never a miss blamed on the app.
            const undecided =
              unreachable !== undefined ||
              (!held && (true === verdict.observationLost || verdict.inconclusive !== undefined));
            // One check per declared step, journaled as act_and_wait journals its own, so the
            // session's result, its run file and the dashboard all count it. See sequence-journal.ts.
            journalStep(
              session,
              { step: i, expect: step['expect'] },
              stepVerdictEffect({
                expect: parsed.data,
                held,
                undecided,
                ...(unreachable === undefined ? {} : { unreachable: true }),
                contradicted,
                expected: verdict.expected,
                observed: held ? undefined : (verdict.observed ?? verdict.failureReason),
                source: asRecord(outcome.result)['source'],
                evidence: verdict.evidence,
                assertion: verdict.assertion,
              }),
            );
            expectations.push({
              declared: true,
              held,
              ...(undecided
                ? {
                    undecided:
                      unreachable !== undefined
                        ? unreachable
                        : true === verdict.observationLost
                          ? `${verdict.failureReason ?? 'the observation was lost'} (the page left)`
                          : (verdict.failureReason ?? 'the predicate could not be read'),
                  }
                : {}),
              ...disagreement,
              ...(verdict.observed === undefined ? {} : { observed: verdict.observed }),
              ...(verdict.expected === undefined ? {} : { expected: verdict.expected }),
            });
            await pushStep({
              ...described,
              expected: verdict.expected ?? true,
              held,
              ...(held ? {} : { observed: verdict.observed ?? verdict.failureReason }),
              // What would have held, on a case-only miss — the verdict stays a miss.
              ...(true === verdict.caseOnlyMiss
                ? { caseOnlyMiss: true, wouldHold: verdict.wouldHold }
                : {}),
            });
            if (!held) {
              stoppedAt ??= i;
              if (DeviationMode.HALT === onDeviation) break;
            }
          }
        } catch (err: unknown) {
          stalledAt = i;
          await pushStep({
            ref: step['ref'],
            action: step['action'],
            dispatched: null,
            timedOut: true,
            error: err instanceof Error ? err.message : 'step timed out',
          });
          break;
        }
      }

      /*
       * Steps that actually ran — which is not the same as the length of the plan.
       *
       * This was `stalledAt ?? inputSteps.length`, from when a stall was the only way to stop early.
       * Halting on an unmet `expect` came later and this never learned about it, so a sequence that
       * stopped at step 2 of 3 answered `completed: 3` while `tail` carried the step it had not run:
       * two accounts of one drive in the response an agent gates on, and the optimistic one was the
       * round number. Measured on a live daemon.
       *
       * The halted step counts: it WAS dispatched, and only the consequence it declared failed
       * afterwards. A stalled step never ran, which is why that index stays exclusive.
       */
      const completed =
        DeviationMode.CONTINUE === onDeviation
          ? (stalledAt ?? inputSteps.length)
          : stoppedAt !== undefined
            ? stoppedAt + 1
            : (stalledAt ?? inputSteps.length);
      if (completed > 0) {
        session.lastAct.markActed(since, undefined, undefined);
      }
      // Same as captureAct: no `active()` gate, so a sequence driven with nothing open still lands
      // in the ambient tape. A stalled plan keeps only the prefix whose steps actually ran.
      let journey: RecordedStep | undefined;
      if (completed > 0) {
        // On the ambient tape a sub-step keeps its `expect` only if it held — same rule as
        // act_and_wait, so an auto-saved flow never replays a claim that was never once observed to
        // hold. A recording somebody opened keeps every claim they declared: dropping a refuted one
        // there saved a flow that replayed green on the very defect it had caught.
        const ran = inputSteps.slice(0, completed).map(asRecord);
        const proved = ran.map((step, i) => {
          const { expect: _expect, ...rest } = step;
          return true === expectations[i]?.held ? step : rest;
        });
        const compiled = (steps: Record<string, unknown>[]): RecordedStep => {
          const step = compileSequenceStep(
            { ...args, steps },
            { count: completed, steps: stepResults.slice(0, completed) },
          );
          // The journey sent a write request: saved `writes`, so a replay does not repeat it unasked.
          if (wroteSince(session, since)) step.writes = true;
          return step;
        };
        const recorded = compiled(proved);
        journey = recorded;
        const onPage = (step: RecordedStep): RecordedStep =>
          pageBefore === undefined ? step : { ...step, page: pageBefore };
        // Every step was on Reticle's own panel: nothing of the app's journey to record.
        const onApp = asRecord(recorded.args)['steps'];
        if (Array.isArray(onApp) && 0 < onApp.length)
          deps.recordings.capture(onPage(compiled(ran)), undefined, session.id, onPage(recorded));
        deps.recordings.markEnded(pathOf(session.url), session.id);
      }
      /*
       * The grade, and the coverage it is never allowed to hide.
       *
       * A plan of twelve steps where three declared a consequence and all three held is verified FOR
       * THOSE THREE and silent about nine. Reporting that as a pass is the arithmetic that buries the
       * nine, so `coverage` rides on every answer and `because` says it in words.
       */
      const grade = gradeSequence(expectations, {
        planned: inputSteps.length,
        dispatched: completed > 0,
      });
      // The journey a `keep` offer names, held as a stopped recording so `reticle_flow_save
      // { flowName: JOURNEY_RECORDING, saveAs }` saves exactly what was just driven. The offer used
      // to name a save that refused with no recording, a dead end that cost a round trip.
      if (journey !== undefined && offerToKeep(grade) !== undefined) {
        deps.recordings.saveCompiled({
          name: JOURNEY_RECORDING,
          version: REPLAY_PROGRAM_VERSION,
          steps: [journey],
          ...(pageBefore === undefined ? {} : { startPath: pageBefore }),
        });
      }
      const tailStart =
        DeviationMode.HALT === onDeviation && stoppedAt !== undefined
          ? stoppedAt + 1
          : (stalledAt ?? inputSteps.length);
      const tail = inputSteps.slice(tailStart);
      return withControl(session, {
        since,
        dispatched: completed > 0,
        completed,
        recorded: journey === undefined ? 0 : completed,
        ...(stalledAt !== undefined ? { stalled_at: stalledAt } : {}),
        ...(stoppedAt !== undefined ? { stopped_at: stoppedAt } : {}),
        verified: grade.verified,
        because: grade.because,
        // Offered at the one moment the compiled program is in hand and free to keep.
        ...((): Record<string, string> => {
          const keep = offerToKeep(grade);
          return keep === undefined ? {} : { keep };
        })(),
        coverage: { declared: grade.declared, total: grade.total },
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
