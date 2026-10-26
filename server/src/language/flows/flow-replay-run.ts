import { resolveFlowUploads } from './fields/flow-upload-resolve.js';
import { withLeaseKeyboard } from '@/surface/tools/real-input-attempt.js';
import { learnFromRun } from '@reticlehq/engine/evidence/learned-guards.js';
import {
  type ProjectId,
  EventType,
  FLOW_SIGNAL_TIMEOUT_MS,
  FlowErrorCode,
  RecordedFlowSchema,
  ReplayStatus,
  RunKind,
  RunStatus,
  type FlowFile,
  type FlowReplayResult,
  type Contradiction,
  type FlowStepResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { haltedFrom } from './recording/replay-halt.js';
import { establishedState } from './flow-journey.js';
import { asString } from '@reticlehq/core';
import { partialStatus, replayFlow, replayWindow, type ReplayFromOptions } from './flow-replay.js';
import { staleTargetResult } from './flow-step-runners.js';
import { assertSuccess, dynamicTestids, successLabel, SUCCESS_STEP_TOOL } from './flow-success.js';
import { buildDecision, unverifiableReason } from './decision.js';
import { unsuppliedSecrets } from './fields/flow-secret-field.js';
import {
  assertStepExpect,
  DocumentLostDuringReplay,
  resumeArg,
  unresolvedResume,
  type FlowReplaySession,
} from './flow-replay.js';
import { isDocumentGoneError } from '@/portal/session/facts/session-replaced.js';
import { classifyFlowAssertions, flattenSteps } from './flow-classify.js';
import { dischargeFlowIntent, flowIntentStatement, flowReplayVerdictId } from './flow-intent.js';
import { IntentStore } from '@/memory/intent/intent-store.js';
import {
  safeSessionTarget,
  sessionRoot,
  type ProjectTarget,
} from '@/memory/project/session-root.js';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { computeSegments } from '@/memory/journal/rollups.js';
import { appScope, stepEffect } from '@reticlehq/engine/evidence/step-effect.js';
import { AssertionTiersStore } from './stores/assertion-tiers-store.js';
import { toFlowSources } from './change/flow-sources.js';
import { reportAndAccumulate } from '@/memory/journal/deviation-service.js';
import { EnvelopeStore } from '@/memory/journal/envelope-store.js';
import type { DeviationReport } from '@/memory/journal/deviation-report.js';
import { homedir } from 'node:os';
import { cloudFetch, syncRunRecordToCloud, SyncOutcome } from '@/memory/cloud/cloud-sync.js';
import { resolveProjectCloud } from '@/memory/cloud/cloud-config.js';
import {
  memoryReadHeaders,
  readMemoryPages,
  scopedMemoryEntries,
} from '@/memory/cloud/memory-scope.js';
import { consultSubjectFor, selectConsulted, type ConsultedMemory } from './flow-memory-consult.js';
import { log } from '@/log.js';
import { replayStepShooter } from '@/features/visual/step-shots.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { flowsForSession } from './flow-store-for-session.js';
import { projectForRoot } from '@/memory/project/project-for-root.js';
import { CROSS_STEP_INDEX, crossStepOnly, declaredIn } from './flow-cross-step.js';
import { arriveAtStartPath, startPathMismatchHint, withStartPageWait } from './flow-start-path.js';

export function latestRecordedFlow(
  events: ReticleEvent[],
): { name: string; flow: import('@reticlehq/core').FlowFile } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== EventType.FLOW_RECORDED) {
      continue;
    }
    const parsed = RecordedFlowSchema.safeParse(event.data);
    if (parsed.success) {
      return { name: parsed.data.name, flow: parsed.data.flow };
    }
  }
  return undefined;
}

export { flowErrorMessage } from './flow-result.js';
import { flowErrorMessage, noteReplayCheck } from './flow-result.js';

/** Replay statuses that represent an actual recorded run in project.json. */
type RecordedReplayStatus = Exclude<ReplayStatus, typeof ReplayStatus.UNVERIFIABLE>;

/** Map the wire ReplayStatus onto the persisted RunStatus (ok→pass). */
function replayToRunStatus(status: RecordedReplayStatus): RunStatus {
  switch (status) {
    case ReplayStatus.OK:
      return RunStatus.PASS;
    case ReplayStatus.DRIFT:
      return RunStatus.DRIFT;
    case ReplayStatus.ERROR:
      return RunStatus.ERROR;
  }
}

/**
 * Append a flow-replay outcome to .reticle/project.json (never throws into replay) and, when logged in,
 * best-effort mirror it to Reticle so the team's server-side regression history stays current. The
 * cloud push is fire-and-forget: not logged in → skipped, a network failure is logged and swallowed.
 */
async function recordReplayRun(
  deps: ToolDeps,
  name: string,
  status: RecordedReplayStatus,
  driftSteps: number,
  durationMs: number,
  projectId: ProjectId | undefined,
  /** The APP's `.reticle`, resolved from the session — never the daemon's own. */
  recordRoot: string,
): Promise<void> {
  const runStatus = replayToRunStatus(status);
  await projectForRoot(deps, recordRoot).recordRun({
    kind: RunKind.FLOW_REPLAY,
    name,
    status: runStatus,
    evidence: { driftSteps },
    durationMs,
  });
  // Per-project cloud: push memory outcomes only when cloud is attached AND memory sync is enabled.
  // Rooted at the APP, not the daemon — see consultProjectMemory. This call had the same defect and
  // it was worse here: a replay outcome that should have reached the dashboard silently did not,
  // because the daemon's own directory has no link file.
  const cloud = await resolveProjectCloud(deps.fs, recordRoot, homedir(), process.env);
  if (null === cloud.config || !cloud.policy.memory) {
    return;
  } // not attached / memory disabled → local only
  const result = await syncRunRecordToCloud(
    { kind: RunKind.FLOW_REPLAY, name, status: runStatus, at: deps.now(), durationMs },
    projectId,
    cloud.config,
    cloudFetch,
  );
  if (result.outcome !== SyncOutcome.SYNCED) {
    log('cloud-run-record-sync-failed', { flow: name, status: result.status, error: result.error });
  }
}

/**
 * Ask the project what it already knows about this flow.
 *
 * Best-effort in the strongest sense: an unlinked project, a disabled memory policy, an offline
 * laptop and a server that answers nonsense all reach the same place — the verdict returns without
 * a memory block. A verification that FAILED because the knowledge lookup failed would be a worse
 * product than one that never looked, and this is the path every replay takes.
 *
 * The read is also what makes the coverage map's fetch counts mean anything: they were zero across
 * the entire corpus, not because memory is useless but because consulting it was a separate act
 * nobody performed. Now the platform performs it.
 */
async function consultProjectMemory(
  deps: ToolDeps,
  flow: FlowFile,
  root: string,
): Promise<ConsultedMemory[] | undefined> {
  const subject = consultSubjectFor(flow);
  if (subject === undefined) {
    return undefined;
  }
  try {
    // The APP's root, not the daemon's (wherever it was launched): its link file is this project's.
    const cloud = await resolveProjectCloud(deps.fs, root, homedir(), process.env);
    if (null === cloud.config || !cloud.policy.memory) {
      return undefined;
    }
    // Scoped to the linked project. The key covers a whole workspace, so a read that named no
    // project could be answered with ANOTHER repo's knowledge and this replay would carry it into a
    // verdict as if it were this app's — see `memory-scope.ts` for the whole shape.
    const config = cloud.config;
    const body = await readMemoryPages(
      config.url,
      { projectId: cloud.projectId, subject },
      async (url) => {
        const res = await cloudFetch(url, {
          method: 'GET',
          headers: memoryReadHeaders(config.apiKey),
        });
        // `res.json` is a METHOD: read as a property it silently made "the project knows nothing".
        return 200 === res.status ? await res.json() : undefined;
      },
    );
    if (body === undefined) {
      return undefined;
    }
    // `undefined`: the response could not be shown to be this project's, so nothing is attached —
    // a verdict carrying another repo's "established knowledge" is worse than none. See memory-scope.
    const entries = scopedMemoryEntries(body, cloud.projectId);
    if (entries === undefined) {
      return undefined;
    }
    const picked = selectConsulted(entries as { statement?: unknown; status?: unknown }[]);
    return 0 === picked.length ? undefined : picked;
  } catch {
    // See the note above: never the reason a verdict fails to return.
    return undefined;
  }
}

/**
 * Replay one named flow end to end: load → re-resolve+run each step → assert the success oracle →
 * status + decision. Shared by reticle_flow_replay (single flow) and reticle_flow_verify (whole suite) so
 * both produce identical FlowReplayResults. Every exit path records a run to project.json.
 */

/**
 * Every flow reachable from this one by `invoke`, loaded once for the whole replay.
 *
 * Breadth-first with a `seen` set so a cycle terminates rather than trusting that typecheck ran.
 * A sub-flow that will not load is simply absent, and the grader then declines to credit it — the
 * conservative direction, because a composite graded on a flow nobody could read is graded on a
 * promise.
 */
async function loadInvokedFlows(
  deps: ToolDeps,
  flow: FlowFile,
  target: ProjectTarget,
): Promise<Map<string, FlowFile>> {
  const out = new Map<string, FlowFile>();
  const queue: FlowFile[] = [flow];
  const seen = new Set<string>([flow.name]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }
    for (const step of flattenSteps(current.steps)) {
      const name = step.invoke;
      if (name === undefined || seen.has(name)) {
        continue;
      }
      seen.add(name);
      const sub = await flowsForSession(deps, target).flows.load(name, target.projectId);
      if (!sub.ok) {
        continue;
      }
      out.set(name, sub.value);
      queue.push(sub.value);
    }
  }
  return out;
}

/**
 * The first precondition this flow declares that does not hold, described for a reader.
 *
 * Undefined means every declared claim held, OR that the flow declared none — and those two are the
 * same answer on purpose. Silence is permissive: every flow recorded before `requires` existed
 * declares nothing, and treating "did not say" as "not satisfied" would make every one of them
 * unverifiable on the day this shipped.
 *
 * Only the FIRST is reported. A reader fixes preconditions one at a time, and the second is usually
 * a consequence of the first being absent.
 */
async function firstUnmetPrecondition(
  session: FlowReplaySession,
  flow: FlowFile,
  since: number,
): Promise<string | undefined> {
  for (const claim of establishedState(flow)) {
    // Zero budget: a precondition is a claim about the state you are starting FROM. Waiting for one
    // turns "was it true" into "did it become true", which is a different and much weaker question.
    let drift: Awaited<ReturnType<typeof assertStepExpect>>;
    try {
      drift = await assertStepExpect(session, claim, waitForPredicate, 0, since);
    } catch (error: unknown) {
      if (!isDocumentGoneError(error)) {
        throw error;
      }
      return `the page went away while this flow's preconditions were being checked, so nothing ran and nothing was proved. Replay again once the page is back.`;
    }
    if (drift !== undefined) {
      return `a precondition of this flow does not hold (${JSON.stringify(claim)}), so nothing ran and nothing was proved. Run the flow that establishes it first, or drive that state yourself.`;
    }
  }
  return undefined;
}

/**
 * The honest answer when the document replay was driving went away mid-run.
 *
 * Not a pass: nothing graded the journey, and the steps in hand are only the ones the departed
 * document answered. Not a failure either — the app was never observed doing anything wrong, and
 * reporting one would be the false red that sends a reader into product code that is fine. So it
 * lands in the bucket this engine already has for "nothing was proved", the same one an unmet
 * precondition uses, with the steps that DID answer attached and no row invented for the one that
 * did not.
 *
 * Why replay reports rather than follows: the successor cannot be identified at the moment the
 * socket closes. `SessionManager.remove` runs from the close handler, writes the tombstone a
 * successor is later matched against, and has nothing to match yet — so the rejection is a plain
 * transport failure by design, and a step in the middle of a journey has no budget to sit and poll
 * with. `navigateAndAwait` CAN wait, because it knows it asked for the navigation, and it does.
 */
export function lostDocumentResult(name: string, lost: DocumentLostDuringReplay): FlowReplayResult {
  return {
    name,
    status: ReplayStatus.UNVERIFIABLE,
    steps: lost.steps,
    unverifiable: {
      reason:
        `the page's connection to Reticle was replaced while step ${String(lost.atStep)} was running ` +
        `(a new document loaded, or its socket reconnected), so the run ` +
        `could not be graded — the steps before it are reported and nothing after it was observed. ` +
        `Nothing here says the app failed. If that navigation is part of the journey, record the ` +
        `step's consequence with \`expect\` and replay again; if it was not, the flow started ` +
        `somewhere it no longer belongs.`,
    },
  };
}

export async function replayNamedFlow(
  deps: ToolDeps,
  args: Record<string, unknown>,
  /** Wraps the session the steps run on, so a caller can watch what they resolved. */
  observe: (session: FlowReplaySession) => FlowReplaySession = (s) => s,
): Promise<FlowReplayResult> {
  const startedAt = deps.now();
  const name = asString(args['flowName']) ?? '';
  // Resolve within the connecting app's scope so a shared daemon replays THIS project's flow, not a
  // same-named flow from another app. Safe-resolve: a missing session degrades to the global store,
  // and the load-then-session order (unchanged) still surfaces a not-found before a no-session error.
  const target = safeSessionTarget(deps, asString(args['sessionId']));
  const { projectId } = target;
  // The app's store, not the daemon's: this load answering `flow_not_found` for a flow plainly on
  // disk is what made replay unusable from a daemon started outside the project.
  const loaded = await flowsForSession(deps, target).flows.load(name, projectId);
  if (!loaded.ok) {
    await recordReplayRun(
      deps,
      name,
      ReplayStatus.ERROR,
      0,
      deps.now() - startedAt,
      projectId,
      sessionRoot(deps, asString(args['sessionId'])),
    );
    return {
      name,
      status: ReplayStatus.ERROR,
      steps: [],
      error: { code: loaded.code, message: flowErrorMessage(loaded.code, loaded.detail) },
    };
  }
  // What this flow is FOR, from the shared ledger — so a failure can report the business outcome
  // that stopped being true before the step that stopped being green. Undefined when nothing
  // declared one, which the decision then says plainly rather than inventing a goal from step names.
  /*
   * The APP's `.reticle`, resolved once. Everything below that reaches the project's own files —
   * the intent ledger, the cloud link, the memory consultation — takes THIS, not `deps.reticleRoot`,
   * which is wherever the daemon happened to be launched.
   */
  const replayRoot = sessionRoot(deps, asString(args['sessionId']));
  const intents = new IntentStore(deps.fs, replayRoot, { now: deps.now });
  const intentSaid = await flowIntentStatement(intents, loaded.value);
  const connected = deps.sessions.resolve(asString(args['sessionId']));
  // The FlowFile contract: replay navigates to the flow's startPath before step 1, and the steps run
  // on the session the SDK reconnects as. When arrival can't be confirmed, replay proceeds on the
  // connected session — and the hint below turns the wrong-page drift into an actionable next move.
  // Continuing at a step means the page is already there; going to the start would undo it.
  const { to, at: continueAt } = replayWindow(args);
  const pool = deps.pool;
  // Only a pool lease can say its page is still loading; any other tab keeps the step budget.
  const stillLoading =
    pool === undefined ? undefined : (): Promise<boolean> => pool.leaseLoading(connected.id);
  const arrival =
    continueAt === undefined
      ? await arriveAtStartPath(
          deps.sessions,
          connected,
          loaded.value,
          undefined,
          undefined,
          stillLoading,
        )
      : {};
  // Continuing on `connected` after the tab left timed every step out on a dead handle (#1129).
  if (arrival.lost !== undefined) {
    const reason = arrival.lost;
    return withStartPageWait(
      {
        name: loaded.value.name,
        status: ReplayStatus.UNVERIFIABLE,
        steps: [],
        unverifiable: { reason },
      },
      arrival,
    );
  }
  const session = arrival.session ?? connected;
  // The reset's own cost outranks the wrong-page hint: if the reload is why step 1 cannot start,
  // "navigate there and replay" is advice that would do the same thing again.
  const startPathHint =
    arrival.redirected ?? arrival.resetCost ?? startPathMismatchHint(loaded.value, session);
  // Floor the success oracle at the start of THIS replay so a stale signal from a prior run
  // in the same session can't fake a pass.
  const replayFloor = session.elapsed();
  // An upload path becomes bytes once, before step 1, against the app's project (#1769).
  const uploadDeps = { fs: deps.fs, reticleRoot: replayRoot };
  const replayable = await resolveFlowUploads(uploadDeps, loaded.value);
  // Loaded once and used for BOTH the replay and the grading below. A composite asserts through
  // what it runs, and a grader that cannot see the sub-flows reports `unverifiable` on a journey
  // that checks itself thoroughly — right about the file, wrong about the journey.
  const invokedFlows = await loadInvokedFlows(deps, replayable, target);
  /*
   * The flow's own preconditions, before a single step runs.
   *
   * A flow states what must already be true for it to mean anything. Replaying one whose `requires`
   * does not hold is not a test of the app: it drives a journey from a state it was never recorded
   * in, and whatever happens next is noise. Until this existed that noise arrived as a FAILURE, and
   * a red that is really a missing precondition is the most expensive kind — it sends a reader into
   * product code that is fine.
   *
   * So an unmet precondition is `unverifiable`, never a failure: nothing ran, so nothing was proved.
   * That is the same honesty rule an uncovered change already follows, and `unverifiable` is already
   * the bucket the suite counts apart from both passes and failures.
   *
   * Judged with the SAME function that judges a step's `expect`, because they are the same shape and
   * two judges drift. Evaluated against the replay floor with no waiting: a precondition is a claim
   * about the state you are starting from, and a claim you have to wait for was not true when you
   * asked.
   */
  /*
   * A credential nobody supplied is not a regression, and must not be reported as one.
   *
   * This sits beside the precondition gate because it is the same mistake in a different coat: the
   * flow cannot run from the state it was recorded in, so whatever happens next says nothing about
   * the app. Replay used to type the literal `<redacted: supply at replay>` into the password box
   * and report the missing dashboard further down as `drift`, pointing at a component nobody had
   * touched. MEASURED on the bench app: supplying one variable moved the suite from 4/30 to 13/34.
   *
   * Checked before the preconditions, because a flow that signs in cannot satisfy anything it
   * requires until it can sign in, and the first reason is the one worth reporting.
   */
  const missing = unsuppliedSecrets(replayable, process.env);
  if (missing.length > 0) {
    const names = missing.map((each) => each.envKey).join(', ');
    return withStartPageWait(
      {
        name: replayable.name,
        status: ReplayStatus.UNVERIFIABLE,
        steps: [],
        unverifiable: {
          reason:
            `this flow fills a redacted field and nothing supplied it, so nothing ran and nothing was ` +
            `proved. Pass it with this call — secrets: { ${missing.map((each) => `"${each.field}": "…"`).join(', ')} } — or set ${names} where the daemon runs and restart it. Until then ` +
            `the value typed would be the placeholder itself, and any failure after it would be ` +
            `about this and not about the application.`,
        },
      },
      arrival,
    );
  }
  const from = resumeArg(args['from']);
  const badResume = unresolvedResume(from, replayable.steps);
  if (badResume !== undefined) {
    const error = { code: FlowErrorCode.STEP_NOT_FOUND, message: badResume };
    return withStartPageWait(
      { name: replayable.name, status: ReplayStatus.ERROR, steps: [], error },
      arrival,
    );
  }
  const unmet = await firstUnmetPrecondition(session, replayable, replayFloor);
  if (unmet !== undefined) {
    return withStartPageWait(
      {
        name: replayable.name,
        status: ReplayStatus.UNVERIFIABLE,
        steps: [],
        unverifiable: { reason: unmet },
      },
      arrival,
    );
  }
  let steps: FlowStepResult[];
  try {
    steps = await replayFlow(
      observe(withLeaseKeyboard(deps, session)),
      replayable,
      waitForPredicate,
      FLOW_SIGNAL_TIMEOUT_MS,
      true === args['confirmDangerous'],
      undefined,
      {
        // How an `invoke` step finds the flow it runs. Scoped to the same project as the flow being
        // replayed, so a composite cannot reach into another app's store for a same-named sub-journey.
        resolveFlow: async (invoked: string) => {
          const sub = await flowsForSession(deps, target).flows.load(invoked, projectId);
          return sub.ok ? await resolveFlowUploads(uploadDeps, sub.value) : undefined;
        },
        // Bug-sweep mode: keep going past a step whose action ran and whose consequence merely did
        // not hold, so one flow reports one verdict per step instead of stopping at the first defect.
        sweep: true === args['sweep'],
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        ...(continueAt === undefined ? {} : { at: continueAt }),
        // The HUD's replay chip, when the human pressed ▶. In-process only: an agent's arguments
        // arrive as JSON and can never carry a function.
        onStepResult: replayStepShooter(deps, session.id),
        ...('function' === typeof args['onStep']
          ? { onStep: args['onStep'] as NonNullable<ReplayFromOptions['onStep']> }
          : {}),
      },
    );
  } catch (error: unknown) {
    if (!(error instanceof DocumentLostDuringReplay)) {
      throw error;
    }
    return withStartPageWait(lostDocumentResult(name, error), arrival);
  }
  // Only part of the journey was driven here: its steps were checked, nothing about the whole flow.
  if (0 < (continueAt ?? 0) || (to !== undefined && to < loaded.value.steps.length)) {
    return withStartPageWait({ name, status: partialStatus(steps), steps }, arrival);
  }
  // Computed HERE, before the synthetic success row is appended below: once that row is pushed,
  // `steps.length` no longer counts only the flow's own steps and the arithmetic is wrong.
  const halted = haltedFrom(steps, loaded.value.steps.length);
  /*
   * The whole-span pass, run once the journey is over. Best-effort: a session stub without
   * `eventsSince` must not abort a healthy replay. A missing cross-step finding costs less.
   */
  const crossStep = ((): Contradiction[] => {
    try {
      const span = { since: replayFloor, until: session.elapsed() };
      const events = session.eventsSince(replayFloor).filter((e) => e.t >= replayFloor);
      const scope = { ...appScope(session), declared: declaredIn(loaded.value.steps) };
      return crossStepOnly(stepEffect(events, span, scope).contradictions ?? [], steps);
    } catch {
      return [];
    }
  })();
  // "green means intent satisfied": when every step ran clean, assert the flow's success
  // end-condition as a real consequence. A signal/net success that never fires FAILS the replay
  // even though all locators resolved — the regression a healed-but-wrong locator ships green.
  const stepsClean = steps.length > 0 && steps.every((s) => s.ok && s.drift === undefined);
  if (stepsClean && loaded.value.success !== undefined) {
    const verdict = await assertSuccess(
      session,
      loaded.value.success,
      dynamicTestids(loaded.value),
      waitForPredicate,
      // The flow's own declaration, not the built-in floor: an app slow enough to need a longer
      // step wait is slow enough that its OUTCOME lands late too, and greening every step only to
      // fail the success oracle at 4s is the same false red one layer down.
      loaded.value.signalTimeoutMs ?? FLOW_SIGNAL_TIMEOUT_MS,
      replayFloor,
    );
    const row: FlowStepResult = {
      step: steps.length,
      tool: SUCCESS_STEP_TOOL,
      anchor: successLabel(loaded.value.success),
      ok: verdict.pass,
      ...(verdict.pass ? {} : { error: verdict.failureReason ?? 'flow.success not satisfied' }),
    };
    steps.push(row);
  }
  const staleTarget = staleTargetResult(name, steps);
  if (staleTarget !== undefined) {
    return withStartPageWait(staleTarget, arrival);
  }
  const driftSteps = steps.filter((s) => s.drift !== undefined).length;
  const allOk = steps.every((s) => s.ok);
  let status: ReplayStatus;
  if (driftSteps > 0) {
    status = ReplayStatus.DRIFT;
  } else if (allOk) {
    status = ReplayStatus.OK;
  } else {
    status = ReplayStatus.ERROR;
  }
  await recordReplayRun(
    deps,
    name,
    status,
    driftSteps,
    deps.now() - startedAt,
    projectId,
    replayRoot,
  );
  // Anti-reward-hacking baseline: record what this flow asserted ONLY when it passed clean. A
  // failing run must never become the baseline a later weakening is measured against.
  if (status === ReplayStatus.OK) {
    await new AssertionTiersStore(deps.fs, replayRoot).recordPassing(
      name,
      loaded.value.steps.map((s, i) => ({
        step: i,
        ...(s.expect === undefined ? {} : { expect: s.expect }),
      })),
      // Record what this flow COVERS so a later deletion can be scoped to the files that changed.
      toFlowSources([{ name, steps: loaded.value.steps }])[0]?.sources ?? [],
    );
    // The ledger learns what this run proved. Only a flow that COULD have gone red discharges: an
    // assertion-free flow is never bound, and `dischargeIntent` refuses an unbound intent, so the
    // guard here is the cheap half of a rule the ledger already enforces. `grade` is what makes a
    // later weakening visible — an intent re-proved by a weaker flow says so in the git diff.
    if (unverifiableReason(loaded.value, invokedFlows) === undefined) {
      const provedAt = deps.now();
      await dischargeFlowIntent(intents, loaded.value, {
        verdictId: flowReplayVerdictId(name, provedAt),
        grade: classifyFlowAssertions(loaded.value).grade,
        at: provedAt,
      });
    }
  }
  // Push-default: the deviation report over this drive's segments, learned across runs. Best-effort.
  const deviation = await computeReplayDeviation(deps, session, replayFloor, replayRoot);
  /*
   * What the team already knows about this flow, fetched on the agent's behalf.
   *
   * Attached to the FAILING path as well as the clean one, deliberately: a drift is exactly the
   * moment somebody needs to know what this feature is supposed to do and who established it. A
   * knowledge base you only see when everything is already fine is decoration.
   */
  // The scope comes from the link file, inside `consultProjectMemory`. It is NOT the API key's
  // job: a key covers a whole workspace and a workspace holds more than one repo, so "bound to one
  // project server-side" was an assumption that handed this replay another app's knowledge.
  const knows = await consultProjectMemory(deps, loaded.value, replayRoot);
  const failed = steps.find((step) => !step.ok && step.drift === undefined);
  if (failed !== undefined) {
    const errored: FlowReplayResult = {
      name,
      status,
      steps,
      error: { code: ReplayStatus.ERROR, message: failed.error ?? 'flow action failed' },
    };
    errored.decision = buildDecision(errored, loaded.value, intentSaid, invokedFlows);
    applyStartPathHint(errored, startPathHint);
    if (deviation !== undefined) {
      errored.deviation = deviation;
    }
    if (knows !== undefined) {
      errored.knows = knows;
    }
    if (crossStep.length > 0) {
      errored.crossStep = crossStep;
    }
    return withStartPageWait(errored, arrival);
  }
  const result: FlowReplayResult = { name, status, steps };
  if (halted !== undefined) {
    result.halted = halted;
  }
  if (knows !== undefined) {
    result.knows = knows;
  }
  // A green that cannot go red is not a pass: the same judgement `reticle_flow_verify` makes.
  const cannotFail =
    status === ReplayStatus.OK ? unverifiableReason(loaded.value, invokedFlows) : undefined;
  if (cannotFail !== undefined) {
    result.unverifiable = { reason: cannotFail };
  }
  // One check of the session that ran it, so its end does not say "nothing was checked".
  noteReplayCheck(session, name, status, cannotFail !== undefined);
  if (status !== ReplayStatus.OK) {
    result.decision = buildDecision(result, loaded.value, intentSaid, invokedFlows);
  }
  applyStartPathHint(result, startPathHint);
  if (deviation !== undefined) {
    result.deviation = deviation;
  }
  if (crossStep.length > 0) {
    result.crossStep = crossStep;
  }
  /*
   * What this run taught the flow.
   *
   * Every contradiction this replay attributed to a step, plus the cross-step ones, compared with
   * what the flow already knew. A defect seen for the first time is remembered as OPEN and asserts
   * nothing; one the flow had open and this run did NOT see becomes GUARDED, and from then on its
   * return is a regression this flow reports by itself, with no new assertion written by hand.
   *
   * `observed` is deliberately tied to whether any step ran. A replay that drove nothing did not
   * find the app clean — it found nothing — and promoting on that would manufacture guards out of
   * an absence of evidence, which is the false green one level up.
   */
  const seenNow = [
    ...steps.flatMap((step, i) =>
      (step.contradictions ?? []).map((c) => ({ kind: c.kind, step: i })),
    ),
    ...crossStep.map((c) => ({ kind: c.kind, step: CROSS_STEP_INDEX })),
  ];
  /*
   * `observed` must mean "the channels reported", not "some steps ran".
   *
   * It was `steps.length > 0`, which is true of essentially every replay — including one where an
   * observer never attached and `seenNow` is empty because NOTHING WAS WATCHING. Two of those in a
   * row promoted an open defect to a guard, which is a guard minted from absence of evidence: the
   * exact failure `learnFromRun` refuses when it is told the truth, and cannot refuse when it is
   * told `steps.length > 0`.
   *
   * The digest is the honest signal. Its own contract says `total` is written unconditionally
   * "because a summary with no keys could not be told apart from one that was never computed" — so
   * a step carrying a digest is a step whose window was actually read, and a replay where no step
   * carries one observed nothing whatever its step count says.
   */
  const learning = learnFromRun({
    guards: loaded.value.learned ?? [],
    seen: seenNow,
    observed: steps.some((step) => step.digest !== undefined),
  });
  result.learned = learning.guards;
  if (learning.promoted.length > 0) {
    result.promoted = learning.promoted;
  }
  if (learning.regressed.length > 0) {
    result.regressed = learning.regressed;
  }
  /*
   * Write it back, or none of the above compounds.
   *
   * The point of learning is that the NEXT replay starts from it. A result field the flow file
   * never receives would make every run learn the same lesson from scratch, which is the state
   * this change exists to leave behind.
   *
   * Best-effort on purpose: a store that refuses the write must not turn a completed replay into a
   * failed one. The verdict is about the app; this is bookkeeping about the flow, and losing a
   * lesson is smaller than losing the run that produced it. Skipped entirely when nothing moved,
   * so a clean replay of a flow with nothing to learn does not rewrite a file for no reason.
   */
  return withStartPageWait(result, arrival);
}

/**
 * The deviation report over a replay's route segments — compared against the learned envelope, which is
 * then updated. Best-effort: any failure (disk, empty window) yields undefined, never breaking the replay.
 */
async function computeReplayDeviation(
  deps: ToolDeps,
  session: { eventsSince(cursor: number): ReticleEvent[] },
  floor: number,
  /** The APP's root — the same one the replay resolved eleven lines above the old call. */
  root: string,
): Promise<DeviationReport | undefined> {
  try {
    const segments = computeSegments(session.eventsSince(floor));
    if (0 === segments.length) {
      return undefined;
    }
    return await reportAndAccumulate(new EnvelopeStore(deps.fs, root), segments);
  } catch {
    return undefined;
  }
}

/** Fold a start-page-mismatch hint onto a non-passing replay's decision (the actionable next move). */
function applyStartPathHint(result: FlowReplayResult, hint: string | undefined): void {
  if (hint === undefined || result.decision === undefined) {
    return;
  }
  result.decision.suggestedFix = hint;
  result.decision.nextAction = hint;
}

/**
 * The connecting session's project, or undefined when no browser is attached. Flow tools use it to
 * scope storage to the current app on a shared daemon; resolving must NOT throw here (list/load are
 * documented to work headless), so a missing/unknown session degrades to the global/legacy store.
 *
 * Re-exported, not re-implemented. This file carried a BYTE-IDENTICAL second copy, and the two
 * drifted the moment `ProjectId` was threaded: `session-root`'s copy returned the brand while this
 * one returned `string`, so every flow tool importing from here was handed a widened value and lost
 * the brand one line after it was minted. Exactly the weak-annotation failure the brand's own doc
 * records against `RunStore.list()`.
 */
export { sessionProjectId } from '@/memory/project/session-root.js';
