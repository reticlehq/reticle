import { mayResumeByReplayingPrefix, StepEffect } from '@reticlehq/core';
import { Surface, formatStepAddress } from 'open-verification';
import { span } from '@/trace.js';
import { anchorLabel, expectElementDrift, resolveTestid, testidDrift } from './flow-anchor.js';
export {
  anchorLabel,
  componentLabel,
  componentQueryArgs,
  editDistance,
  expectElementDrift,
  nearestIsAmbiguous,
  nearestTestid,
  resolveQuery,
  testidDrift,
} from './flow-anchor.js';
import type { FlowReplaySession, WaitForSignal, Sleep } from './flow-replay-types.js';
export type { FlowReplaySession, WaitForSignal, Sleep } from './flow-replay-types.js';
import { routeOfEvent } from '@reticlehq/engine/question/predicate/predicate-route.js';
import { stepEffect } from '@reticlehq/engine/evidence/step-effect.js';
import {
  AnchorKind,
  DriftReason,
  EventType,
  FlowStepTool,
  ReticleCommand,
  type Drift,
  type FlowFile,
  type FlowStep,
  type FlowStepResult,
  type FlowExpect,
  type ReticleEvent,
  PredicateKind,
} from '@reticlehq/core';
import { asString, isConsequenceDrift } from '@reticlehq/core';
import { replayActionArgs, ambiguousTestidNote } from './replay.js';
import { anchorFieldName } from './fields/flow-secret-field.js';
import {
  degradedStepResult,
  isDegradedAnchor,
  runComponentStep,
  runRoleStep,
  runSequenceStep,
} from './flow-step-runners.js';
import { successToPredicate } from './flow-success.js';
import { ReticleTool } from '@reticlehq/core';
import type { Predicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { inFlightRequestLabels } from '@/surface/tools/act/settle-in-flight.js';
import { namedNetIsInFlight } from '@reticlehq/engine/evidence/unsettled.js';

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The route (pathname) currently in effect — the page a step runs on. Reads the latest ROUTE_CHANGE
 * from the whole event buffer; mirrors the predicate engine's route field order (pathname → to).
 * Returns undefined when no route has been observed (e.g. a fake session) so `page` stays optional.
 */
function currentRoute(session: FlowReplaySession): string | undefined {
  const routes = session.eventsSince(0).filter((e) => e.type === EventType.ROUTE_CHANGE);
  const last = routes.at(-1);
  if (last === undefined) return undefined;
  // The ROUTER's path. This field answers "which page did this step run on", and the document
  // pathname is `/` on every page of a hash-routed app — so a whole desktop replay reported `/` for
  // every step. Sixth place the same reading was wrong; see routeOfEvent.
  const parts = routeOfEvent(last);
  if (parts === undefined || 0 === parts.docPath.length) return undefined;
  return parts.routePath.length > 0 ? parts.routePath : undefined;
}

/** Pathname only (drop origin + query) so a net URL stays terse in the journey. */
function trimUrl(url: string): string {
  try {
    return new URL(url, 'http://x').pathname;
  } catch {
    return url.length > 60 ? `${url.slice(0, 59)}…` : url;
  }
}

/**
 * A compact "what happened after this step" summary from the post-action event window — the
 * journey's consequence column ("→ /deployments", "signal modal:opened", "GET /api/x 500"). Notable
 * events only (route / domain signal / network / console error), terse and capped to stay token-cheap.
 */
function summarizeConsequence(events: ReticleEvent[]): string | undefined {
  const parts: string[] = [];
  const lastRoute = events.filter((e) => e.type === EventType.ROUTE_CHANGE).at(-1);
  if (lastRoute !== undefined) {
    const routed = routeOfEvent(lastRoute);
    if (routed !== undefined && routed.routePath.length > 0) parts.push(`→ ${routed.routePath}`);
  }
  const signals = new Set<string>();
  for (const e of events) {
    if (e.type !== EventType.SIGNAL) continue;
    const name = asString((e.data ?? {})['name']);
    if (name !== undefined) signals.add(name);
  }
  for (const name of [...signals].slice(0, 2)) parts.push(`signal ${name}`);
  for (const n of events.filter((e) => e.type === EventType.NET_REQUEST).slice(0, 2)) {
    const data = n.data ?? {};
    const method = asString(data['method']) ?? 'GET';
    const path = trimUrl(asString(data['url']) ?? '');
    const status = 'number' === typeof data['status'] ? ` ${data['status']}` : '';
    parts.push(`${method} ${path}${status}`.trim());
  }
  const errors = events.filter(
    (e) => e.type === EventType.CONSOLE_ERROR || e.type === EventType.ERROR_UNCAUGHT,
  ).length;
  if (errors > 0) parts.push(`${errors} console error${errors > 1 ? 's' : ''}`);
  return parts.length > 0 ? parts.join('; ') : undefined;
}

/** Run one testid-anchored step: re-resolve via QUERY, then ACT on the live ref, else drift. */
async function runTestidStep(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  value: string,
  dynamic: ReadonlySet<string>,
  confirmDangerous: boolean,
  sleep: Sleep,
): Promise<FlowStepResult> {
  const { refs, hint } = await resolveTestid(session, value, sleep);
  if (0 === refs.length) {
    return {
      step: index,
      tool: step.tool,
      anchor: value,
      ok: false,
      drift: testidDrift(value, hint),
    };
  }
  const ref = refs[0] ?? '';
  const note = refs.length > 1 ? ambiguousTestidNote(value) : undefined;
  session.beginAction?.(ReticleTool.FLOW_REPLAY, { ref, action: step.action ?? '' });
  let act;
  try {
    act = await session.command(ReticleCommand.ACT, {
      ref,
      action: step.action ?? '',
      // The field this step types into — from the anchor, so a redacted fill can be supplied from
      // RETICLE_SECRET_<FIELD> without the flow carrying the secret. The testid runner used to pass
      // the testid string here and the other two runners passed nothing, so a role-anchored login
      // typed the literal placeholder.
      args: replayActionArgs(step.args, confirmDangerous, anchorFieldName(step.anchor)),
    });
  } finally {
    session.finishAction?.();
  }
  const result: FlowStepResult = { step: index, tool: step.tool, anchor: value, ok: act.ok };
  if (!act.ok) {
    result.error = act.error ?? 'command failed';
    if (note !== undefined) result.note = note;
    return result;
  }
  // assert the step's expect.element testid is present AFTER the action —
  // unless that testid was marked DYNAMIC (the LLM-output case), in which case its presence/content
  // is NOT asserted (only the action ran). The skip is scoped strictly to the dynamic set.
  const expectTestid = step.expect?.element?.testid;
  if (expectTestid !== undefined && !dynamic.has(expectTestid)) {
    const expectRefs = await resolveTestid(session, expectTestid, sleep);
    if (0 === expectRefs.refs.length) {
      return {
        step: index,
        tool: step.tool,
        // The step's OWN anchor, not the expectation's target. Replay stops at the first drift, so
        // this result is the only thing the caller sees about why the run ended — naming the
        // assertion here reads as "step N's locator drifted" and hides that the action did run.
        anchor: value,
        ok: false,
        drift: expectElementDrift(expectTestid, expectRefs.hint),
      };
    }
  }
  if (note !== undefined) result.note = note;
  return result;
}

/**
 * After a step's anchor resolves and its action runs, its `expect` is EVALUATED — every kind of it.
 *
 * For a long time only `expect.state` was, so a recorded `expect.signal` or `expect.net` was written
 * to disk and read by nothing while `flow_save` graded the flow "asserted". Driven end to end over
 * MCP: annotate a step with a signal that never fires, save (grade "asserted"), replay -> status
 * "ok". A green that cannot go red, inside the feature whose job is catching exactly that.
 *
 * It compiles through the SAME `successToPredicate` the flow-level `success` has always used, so
 * there is one definition of what an expect means and the step form cannot drift from it again.
 * Turning this on makes previously-green flows go red. That is the point — they were green because
 * nothing was looking.
 */
/**
 * Exported so a PRECONDITION is judged by the same code that judges a consequence.
 *
 * `requires` and `expect` are the same shape on purpose: a precondition is a consequence somebody
 * else's flow was responsible for. Evaluating them with two different functions is how the two
 * quietly stop agreeing, and the disagreement would land as a flow that replays green against a
 * state it was never meant to run in.
 */
export async function assertStepExpect(
  session: FlowReplaySession,
  expect: NonNullable<FlowStep['expect']>,
  dynamic: ReadonlySet<string>,
  waitForSignal: WaitForSignal,
  timeoutMs: number,
  since: number,
): Promise<Drift | undefined> {
  // A testid is already asserted against the live DOM by the step runner. A role/name locator is
  // not that path — stripping every element made a recorded `until` by button name a no-op, so a
  // flow that proved the control at capture time could not go red when it was gone.
  const consequences: FlowExpect = { ...expect };
  if (undefined !== consequences.element?.testid) {
    delete consequences.element;
  }
  const predicate = successToPredicate(consequences, dynamic);
  if (predicate === undefined) return undefined;
  const verdict = await waitForSignal(session, predicate, timeoutMs, since);
  if (verdict.pass) return undefined;

  // The budget ended; that does not mean the call never happened. A request matching this step's
  // URL and method may be sitting on the wire right now, and "no network call matched POST
  // /geometry" reads as a feature that regressed. See pendingRequestDrift.
  const pending = pendingRequestDrift(session, expect, predicate, since);
  if (pending !== undefined) return pending;

  return {
    // The store case keeps its own kind because heal and the run report branch on it; everything
    // else is a consequence that did not hold, and the reason carries observed-vs-expected.
    reasonKind:
      expect.state !== undefined ? DriftReason.STATE_MISMATCH : DriftReason.SIGNAL_NOT_OBSERVED,
    reason: verdict.failureReason ?? "the step's declared consequence did not hold",
    anchor: expectLabel(expect),
    nearest: null,
  };
}

/**
 * The drift for a step whose wait expired while its own request was still open, or undefined.
 *
 * Undefined is the common case and has to stay cheap: an ordinary miss keeps the reason it had, and
 * an unrelated poll left hanging must not pardon a named URL that never started -- which is exactly
 * what `namedNetIsInFlight` discriminates, and why this reuses it instead of matching URLs here.
 *
 * The verdict stays a drift. The step did not prove its consequence, and pretending otherwise would
 * be the opposite error. What changes is what a reader is sent to do about it: a budget to raise
 * (`timeoutMs` on the step, or `signalTimeoutMs` on the flow) rather than a deleted feature to hunt.
 */
function pendingRequestDrift(
  session: FlowReplaySession,
  expect: NonNullable<FlowStep['expect']>,
  predicate: Predicate,
  since: number,
): Drift | undefined {
  const stillInFlight = inFlightRequestLabels(session.eventsSince(since));
  if (!namedNetIsInFlight(predicate, stillInFlight)) return undefined;
  return {
    reasonKind: DriftReason.REQUEST_STILL_IN_FLIGHT,
    reason:
      `the wait ended while a matching request was STILL IN FLIGHT (${stillInFlight.join(', ')}), ` +
      'so this is a timeout against a slow app, not a call that never happened. Raise the budget — ' +
      '`timeoutMs` on this step, or `signalTimeoutMs` on the flow — before looking for a regression',
    anchor: expectLabel(expect),
    nearest: null,
  };
}

/** Name the thing that was asserted, for the drift's `anchor` column. */
function expectLabel(expect: NonNullable<FlowStep['expect']>): string {
  if (expect.signal !== undefined) return `signal:${expect.signal}`;
  if (expect.net !== undefined) return `net:${expect.net.urlContains ?? expect.net.method ?? '*'}`;
  if (expect.state !== undefined) return `state:${expect.state.path}`;
  if (expect.console !== undefined) return `console:${expect.console.level ?? '*'}`;
  if (undefined !== expect.element) {
    return expect.element.testid ?? expect.element.name ?? expect.element.role ?? 'element';
  }
  return 'expect';
}

/** Run one signal-anchored step: wait for the signal predicate, else drift (no nearest for signals). */
async function runSignalStep(
  session: FlowReplaySession,
  step: FlowStep,
  index: number,
  name: string,
  waitForSignal: WaitForSignal,
  signalTimeoutMs: number,
  since: number,
): Promise<FlowStepResult> {
  // Scope to THIS replay's floor, not the whole buffer.
  //
  // A signal step is a pure wait — the signal is fired by the PRECEDING act step — so a per-step floor
  // would miss it (false negative). But the default whole-buffer read (since=0) was too loose in the
  // one place it matters most: reticle_flow_verify replays every saved flow back-to-back in ONE
  // session, so a signal an EARLIER flow emitted (`auth:granted`, `nav:changed`) sat in the buffer and
  // satisfied a LATER flow's signal step even when that flow's own action never fired it — a
  // cross-flow false green on the exact suite-verify path the regression-cost claim rests on. The
  // replay-start floor excludes prior flows/runs while still seeing this run's adjacent-step signal.
  const verdict = await waitForSignal(
    session,
    { kind: PredicateKind.SIGNAL, name },
    signalTimeoutMs,
    since,
  );
  if (verdict.pass) return { step: index, tool: step.tool, anchor: name, ok: true };
  return {
    step: index,
    tool: step.tool,
    anchor: name,
    ok: false,
    drift: {
      reasonKind: DriftReason.SIGNAL_NOT_OBSERVED,
      reason: `signal "${name}" not observed`,
      anchor: name,
      nearest: null,
    },
  };
}

/**
 * Replay a loaded flow by RE-RESOLVING every step's semantic anchor against the live DOM — never
 * a stale ref. A testid anchor is re-found by reticle_query; a signal anchor waits on a predicate.
 * On the first anchor MISS the step carries legible drift and replay STOPS, returning the partial
 * results. This is the "whose fault is it" contract, not a blind "command failed".
 */
/** Where a replay starts reporting. Steps before it are re-driven, silently, as setup. */
export interface ReplayFromOptions {
  from?: number;
  /**
   * How to load a flow this one INVOKES. Absent means invocations cannot be followed.
   *
   * A composite whose sub-flow cannot be loaded must FAIL and say so. It must not be reported as a
   * missing anchor — which is what happened before this existed: the invoke step fell through to
   * the anchor path and replay went looking for an element with a testid literally named
   * `demo/signin`, then reported the journey as NO LONGER TRUE with a suggested fix of "sign-out".
   * Every word of that was wrong, and it was found by driving, not by a unit test — the in-memory
   * replayer had honoured invocations for an hour by then. Two replay paths; one was wired.
   */
  resolveFlow?: (name: string) => Promise<FlowFile | undefined>;
  /** The invocation chain that reached this flow, nearest caller first. Empty at the top. */
  via?: readonly { flow: string; step: number }[];
  /**
   * Which kind of subject this is. Decides whether re-driving the prefix is allowed at all.
   *
   * Defaults to `web`, which is the permissive answer — correct for the only surface that resumes
   * today, and the reason a caller on a committing surface must say so rather than rely on silence.
   */
  surface?: Surface;
  /**
   * Keep going past a step whose ACTION ran and whose declared consequence merely did not hold.
   *
   * Off by default, because a regression flow wants the first break and nothing after it. A BUG
   * SWEEP wants the opposite: a flow that declares what each step SHOULD do, driven against an app
   * where several of them do not, and one verdict per step. Without this the sweep stops at the
   * first defect and reports the rest as `notAttempted` — measured on a 6-step flow that halted at
   * step 0 with five real defects behind it.
   *
   * An ANCHOR drift still halts either way: there the element was never found, so the page is not
   * where the flow says it is and continuing would invent results. `isConsequenceDrift` is the line.
   */
  sweep?: boolean;
}

/**
 * Where to start REPORTING — and whether re-driving the steps before it is allowed at all.
 *
 * "Resume is nearly free, just re-run the prefix" is true of a browser and false on a subject that
 * COMMITS. Re-driving a prefix on a service re-sends every request before step N; on a device it
 * moves an arm again. Neither is a convenience, and a protocol that did it silently would be
 * defective rather than helpful.
 *
 * So the surface's declared profile decides, through the specification's own `resumeStrategy` rather
 * than a local reading of `replayPrefix`. A refusal resumes from 0 — the whole journey is reported,
 * nothing is skipped and nothing is silently repeated beyond what a plain replay already does.
 */
function resumableFrom(options: ReplayFromOptions, steps: readonly FlowStep[]): number {
  const asked = Math.max(0, options.from ?? 0);
  if (0 === asked) return 0;
  if (!mayResumeByReplayingPrefix(options.surface ?? Surface.WEB)) return 0;
  /*
   * The surface answers for the SUBJECT; a step answers for itself.
   *
   * `web` is the permissive profile and it is right about a browser in general and wrong about the
   * one click that charges a card. The surface check cannot see that, because the distinction is
   * not a property of the realm — it is a property of the step. A flow that declares a prefix step
   * as `commits` is saying: re-running me is not free, whatever the surface thinks.
   *
   * Refusing means resuming from 0, which is the same fail-safe the surface refusal already uses:
   * the whole journey is reported and nothing is silently repeated beyond what a plain replay does.
   * Absent effect is UNKNOWN and stays permissive — every flow recorded before this shipped has no
   * effect on any step, and assuming the worst there would refuse every resume in existence.
   */
  const commitsInPrefix = steps.slice(0, asked).some((step) => StepEffect.COMMITS === step.effect);
  return commitsInPrefix ? 0 : asked;
}

/**
 * Run an `invoke` step: load the named flow and replay it, or fail saying why.
 *
 * Never silently skipped. An invocation that cannot be followed and is reported as OK would mean a
 * composite replays green having run none of its sub-journeys — a false green arriving through the
 * feature meant to make verification stronger.
 *
 * The nested steps are NOT spliced into the caller's results. A composite's own step list stays its
 * own, and the sub-journey's outcome is summarised on the invocation, so a reader sees the shape
 * they recorded rather than a flattened list that has lost every boundary.
 */
async function runInvokeStep(
  session: FlowReplaySession,
  flow: FlowFile,
  step: FlowStep,
  index: number,
  waitForSignal: WaitForSignal,
  signalTimeoutMs: number,
  confirmDangerous: boolean,
  sleep: Sleep,
  options: ReplayFromOptions,
): Promise<FlowStepResult> {
  const name = step.invoke ?? '';
  const via = options.via ?? [];
  const here = { flow: flow.name, step: index, via };
  const address = formatStepAddress(here);
  const base = { step: index, tool: FlowStepTool.INVOKE, anchor: name, at: address };
  const chain = [...via.map((v) => v.flow), flow.name];
  if (chain.includes(name)) {
    return {
      ...base,
      ok: false,
      error: `invocation returns to a flow already running: ${[...chain, name].join(' → ')}`,
    };
  }
  const sub = options.resolveFlow === undefined ? undefined : await options.resolveFlow(name);
  if (sub === undefined) {
    return {
      ...base,
      ok: false,
      error: `cannot replay "${name}": it was not found, so this journey would report green having never run it`,
    };
  }
  // `from` is deliberately dropped rather than forwarded: it is a REPORTING offset into the
  // caller's own step list, and applying it inside a sub-journey would silently hide that
  // journey's first steps for a reason that has nothing to do with it.
  const { from: _ignored, ...carried } = options;
  const nested = await replayFlow(
    session,
    sub,
    waitForSignal,
    signalTimeoutMs,
    confirmDangerous,
    sleep,
    {
      ...carried,
      via: [{ flow: flow.name, step: index }, ...via],
    },
  );
  const failed = nested.find((r) => false === r.ok);
  if (failed !== undefined) {
    return {
      ...base,
      ok: false,
      error: `"${name}" failed at ${failed.at ?? `step ${String(failed.step)}`}: ${failed.error ?? 'see that flow'}`,
      ...(failed.drift === undefined ? {} : { drift: failed.drift }),
    };
  }
  return { ...base, ok: true, note: `ran ${name} (${String(nested.length)} step(s))` };
}

export async function replayFlow(
  session: FlowReplaySession,
  flow: FlowFile,
  waitForSignal: WaitForSignal,
  signalTimeoutMs: number,
  confirmDangerous = false,
  sleep: Sleep = realSleep,
  options: ReplayFromOptions = {},
): Promise<FlowStepResult[]> {
  const results: FlowStepResult[] = [];
  /*
   * Where to start REPORTING. Everything before it still runs.
   *
   * Resuming is re-driving the prefix, not restoring state: there is no way to put an app back
   * where it was without driving it there, and at a measured ~27ms a step there is no reason to
   * try. So the prefix executes silently and the caller sees the journey from the point it asked
   * about -- which is what makes "fix the break, resume, find the next one" a loop rather than a
   * full re-read each time.
   */
  const from = resumableFrom(options, flow.steps);
  // testids whose region is LLM-dynamic — their expect-presence is NOT asserted.
  const dynamic = new Set<string>(
    (flow.dynamic ?? [])
      .filter((a) => a.kind === AnchorKind.TESTID)
      .map((a) => (a.kind === AnchorKind.TESTID ? a.value : '')),
  );
  // Floor for signal steps: signals that fire during THIS replay, never a prior flow/run in the same
  // session. Captured once, before any step, so a back-to-back suite verify cannot cross-satisfy.
  const replayFloor = session.elapsed();
  // How long a step waits for its consequence: the step's own declaration, else the flow's, else the
  // caller's default. Resolved per step rather than once, because one slow step in an otherwise fast
  // journey is the common shape — a file import, a model-backed endpoint — and making the whole flow
  // wait for the slowest step would trade a false red for a slow suite. See FlowStep.timeoutMs.
  const waitFor = (step: FlowStep): number =>
    step.timeoutMs ?? flow.signalTimeoutMs ?? signalTimeoutMs;
  let index = 0;
  for (const step of flow.steps) {
    if (step.invoke !== undefined) {
      results.push(
        await runInvokeStep(
          session,
          flow,
          step,
          index,
          waitForSignal,
          signalTimeoutMs,
          confirmDangerous,
          sleep,
          options,
        ),
      );
      const last = results[results.length - 1];
      if (last !== undefined && false === last.ok) break;
      index += 1;
      continue;
    }
    const label = anchorLabel(step.anchor);
    // The page this step runs on (the journey's "which page") — captured before the action.
    const page = currentRoute(session);
    // Event-time floor so the consequence reflects only THIS step's aftermath, not prior steps'.
    const cursorBefore = session.elapsed();
    const subSteps = step.steps;
    // Traced per step, so a slow replay says WHICH step and which anchor kind spent the time. The
    // per-step `durationMs` below is what the agent gets back; this is what a developer profiling
    // the replay engine gets, nested under the tool call with the browser round-trips beneath it.
    const result: FlowStepResult = await span(
      'flow.step',
      { index, anchor: step.anchor.kind, label },
      async () => {
        if (isDegradedAnchor(step.anchor)) {
          // Never QUERY the sentinel — it marks "no anchor was determined", not an element to find.
          return degradedStepResult(step, index, label);
        }
        if (subSteps !== undefined && subSteps.length > 0) {
          return runSequenceStep(session, step, index, subSteps, confirmDangerous, sleep, dynamic);
        }
        if (step.anchor.kind === AnchorKind.SIGNAL) {
          return runSignalStep(
            session,
            step,
            index,
            label,
            waitForSignal,
            waitFor(step),
            replayFloor,
          );
        }
        if (step.anchor.kind === AnchorKind.COMPONENT) {
          return runComponentStep(session, step, index, step.anchor, confirmDangerous, sleep);
        }
        if (step.anchor.kind === AnchorKind.ROLE && step.anchor.name !== undefined) {
          // A NAMED role anchor addresses one element. The nameless one is the degraded placeholder
          // and keeps its old path, where it fails legibly rather than querying a role as a testid.
          return runRoleStep(session, step, index, step.anchor, confirmDangerous, sleep);
        }
        return runTestidStep(session, step, index, label, dynamic, confirmDangerous, sleep);
      },
    );
    // Once the anchor resolved and the action ran, the step's own expect is evaluated — signal, net,
    // console and store truth alike — deterministically, in the same cheap replay loop, with no LLM.
    /*
     * The step's own expect, and then every sub-step's.
     *
     * `classifyFlowAssertions` already walks act_sequence sub-steps and counts an expect on either
     * level, and states the invariant plainly: this and what replay enforces must move together, or
     * "the difference is a false green or a lost verification". Enforcing only the top level was
     * that difference -- a sequence whose sub-step declared a consequence was GRADED asserted and
     * checked by nothing, so it could not go red while wearing the grade that says it could.
     *
     * WEAKER THAN THE LIVE PATH, and deliberately so rather than silently. A recorded sequence is
     * dispatched as ONE batched command, so there are no per-sub-step cursors to open a window with
     * -- every sub-step expect is evaluated against the window the whole sequence opened, which
     * means sub-step three's claim can be satisfied by sub-step one's consequence. The live
     * `act_sequence` path takes a cursor before each dispatch and does not have this. Narrowing it
     * here means dispatching sub-steps individually on replay, which is a behaviour change to the
     * replay path and belongs in its own commit.
     */
    const declared = [step.expect, ...(step.steps ?? []).map((sub) => sub.expect)].filter(
      (expectation): expectation is NonNullable<FlowStep['expect']> => expectation !== undefined,
    );
    for (const expectation of declared) {
      if (!result.ok || result.drift !== undefined) break;
      const expectDrift = await assertStepExpect(
        session,
        expectation,
        dynamic,
        waitForSignal,
        waitFor(step),
        cursorBefore,
      );
      if (expectDrift !== undefined) {
        result.ok = false;
        result.drift = expectDrift;
      }
    }
    if (page !== undefined) result.page = page;
    const windowEvents = session.eventsSince(cursorBefore).filter((e) => e.t >= cursorBefore);
    const consequence = summarizeConsequence(windowEvents);
    if (consequence !== undefined) result.consequence = consequence;
    // Per-step wall time is NOT shipped: it is `window.until - window.since`, computed from two numbers
    // the next line already puts in the same object, under the same emission condition. A step used to
    // carry the subtraction AND both operands, on every step of every replay.
    const cursorAfter = session.elapsed();
    // ONE builder, shared with the live act path, so a driven step and a replayed one describe what
    // happened in identical words rather than in two vocabularies that agree by coincidence.
    Object.assign(result, stepEffect(windowEvents, { since: cursorBefore, until: cursorAfter }));
    /*
     * A prefix step is setup and is not reported -- UNLESS it failed.
     *
     * A failure there means the resume never reached the step it was asked to resume from, and the
     * run did not start where the caller will read it as having started. Swallowing it would turn
     * "I could not get there" into "I got there and it was fine".
     */
    // `tool` is dropped HERE rather than at the ten places that set it, so a new step runner cannot
    // forget the rule and quietly re-introduce the cost. Spelled out only when it is NOT the default.
    if (FlowStepTool.ACT === result.tool) delete result.tool;
    if (index >= from || !result.ok || result.drift !== undefined) results.push(result);
    // Under `sweep`, a failure whose action still RAN does not stop the run — the page is where the
    // step left it, so the next step is as meaningful as it was going to be. Anything else halts.
    const sweepPast =
      true === options.sweep &&
      result.drift !== undefined &&
      isConsequenceDrift(result.drift.reasonKind);
    if (!sweepPast && (result.drift !== undefined || !result.ok)) break;
    index += 1;
  }
  return results;
}
