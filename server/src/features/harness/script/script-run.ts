/**
 * Run a drive script: lanes side by side, journeys in order, every step through Reticle's own tools.
 *
 * Replays, exact acts and asserts need no model and are judged by the tool's own verdict. Only an
 * open goal reaches the model. The browser, the model and the clock of concurrency all arrive as
 * ports, so the scheduling below is tested without either.
 *
 * Barriers cannot deadlock: a journey only waits on one in an EARLIER lane (`checkScript`), lanes
 * are started in order, so whatever is waited on has already started.
 */
import {
  PredicateKind,
  ReplayStatus,
  ReticleTool,
  ScriptStatus,
  Verified,
  asRecord,
  asString,
  type PlanView,
} from '@reticlehq/core';
import {
  JourneyBy,
  JourneyOutcome,
  ScriptStepKind,
  barriersOf,
  stepLabel,
  type DriveScript,
  type Journey,
  type ScriptLeafStep,
  type ScriptStep,
} from '@reticlehq/core/artifacts';
import { ReplayOutcome, checkTally, replayedFlows } from '../drive-report.js';
import { lookFor, parseGoals } from '../goals.js';
import {
  DEFAULT_MAX_STEPS,
  StopReason,
  type HarnessResult,
  type HarnessToolset,
  type ToolOutcome,
} from '../harness.js';

export interface ScriptPorts {
  /** A browser context for one lane. Without a pool this is the user's own tab, every time. */
  lease(laneId: string): Promise<{ sessionId?: string; release(): Promise<void> }>;
  /** Reticle's tools on a lane's tab, as the journey's persona when it has one. */
  toolset(sessionId: string | undefined, persona: string | undefined): HarnessToolset;
  /** Hand an open goal to the model, on that toolset. */
  drive(toolset: HarnessToolset, goal: string, maxSteps: number): Promise<HarnessResult>;
  /** Lanes at once. 1 when there is no pool, so lanes take turns on the one tab. */
  parallel: number;
  /** A person switched autonomous driving off. */
  stopped(): boolean;
  /**
   * A person started this run and acknowledged the saved flows' destructive steps: replays take
   * them. Never applied to a step the model decides.
   */
  confirmDangerous?: boolean;
  /**
   * Text the Harness wrote itself (the journey asked for, the plan's titles and goals): a page
   * showing it back, as the saved plan's name on /plans, is not a journey's end reached.
   */
  own?: readonly string[];
  /**
   * Why the model may not drive a journey's fallback now (credits gone, Harness off), or undefined
   * when it may. Asked only when a fallback is about to run: a plan that only replays never pays.
   */
  fallbackRefused?(): Promise<string | undefined>;
}

/** How one journey was answered, as the platform is told it. */
export interface JourneyRun {
  id: string;
  /** Absent when it neither replayed nor drove: a guard stopped it first. */
  by?: JourneyBy;
  /** Model tokens the journey spent, cache reads and writes included; 0 for a pure replay. */
  tokens: number;
  /** Credits its model drives spent, when the platform said. */
  credits?: number;
  /** The flows it replayed or recorded. */
  flows: string[];
}

export interface ScriptRun {
  view: PlanView;
  /** Every tool call the run made, in the order each lane made them. */
  toolCalls: ToolOutcome[];
  /** The model drives the open goals took. */
  drives: HarnessResult[];
  stopped: boolean;
  /** One line per journey, for the drive's report. */
  lines: string[];
  /** Each journey that ran, once, however many lanes held it. */
  journeys: JourneyRun[];
}

/** Why a journey failed when its goal, not a check, is what was missing. */
const GOAL_NOT_REACHED = 'the goal was not reached, though its checks may have held';

/** A planned open journey gets the same budget a named persona drive gets. */
const OPEN_GOAL_STEPS = DEFAULT_MAX_STEPS;

/** Fewer model turns left than this and a continuation could not take the step it is sent for. */
const MIN_CONTINUE_STEPS = 3;

/** Why a journey whose replays decided nothing was handed to the model. */
const FELL_BACK = 'its replays decided nothing, so the model drove its goal';

/** A replay that neither held nor failed: drifted, unverifiable, or a flow not on this computer. */
const UNDECIDED_REPLAY: ReadonlySet<string | undefined> = new Set([
  ReplayOutcome.DRIFT,
  ReplayOutcome.MISSING,
  ReplayStatus.UNVERIFIABLE,
  undefined,
]);

/**
 * The journey's replays decided nothing about the app: one could not anchor or run, and none failed.
 * A held sign-in beside a drifted mid-session flow is not a failure of the app, and read "Failed".
 */
function replaysDecidedNothing(calls: readonly ToolOutcome[]): boolean {
  const replays = replayedFlows(calls);
  return (
    replays.some((r) => UNDECIDED_REPLAY.has(r.status)) &&
    !replays.some((r) => ReplayOutcome.ERROR === r.status)
  );
}

/** Why a journey whose replay could not anchor or run is undecided, not failed. */
const msgReplayUndecided = (flow: string): string =>
  `the recording ${flow} could not anchor or run on this app, which decides nothing about the app`;

/** The flows a journey replayed or saved, each once, in the order it touched them. */
function flowsOf(calls: readonly ToolOutcome[]): string[] {
  const names = calls.flatMap((call) => {
    if (ReticleTool.FLOW_REPLAY === call.name) return [asString(asRecord(call.args)['flowName'])];
    if (ReticleTool.FLOW_SAVE !== call.name || call.isError) return [];
    const args = asRecord(call.args);
    return [
      asString(asRecord(call.result)['name']) ??
        asString(args['saveAs']) ??
        asString(args['flowName']),
    ];
  });
  return [...new Set(names.filter((n): n is string => n !== undefined))];
}

/** What a journey's own model drives cost, and what it touched. */
function journeyRun(id: string, calls: readonly ToolOutcome[], own: HarnessResult[]): JourneyRun {
  const credits = own.flatMap((d) => (d.creditsSpent === undefined ? [] : [d.creditsSpent]));
  // Replayed only when it replayed: a model goal the end-already-shown guard stopped spent no
  // tokens and was called "replayed, no model tokens" on a journey that had no replay at all.
  const by =
    0 < own.length
      ? JourneyBy.MODEL
      : 0 < replayedFlows(calls).length
        ? JourneyBy.REPLAY
        : undefined;
  return {
    id,
    ...(by === undefined ? {} : { by }),
    tokens: own.reduce(
      (n, d) => n + d.usage.input + d.usage.output + d.usage.cacheRead + d.usage.cacheWrite,
      0,
    ),
    ...(0 === credits.length ? {} : { credits: credits.reduce((a, b) => a + b, 0) }),
    flows: flowsOf([...calls, ...own.flatMap((d) => d.toolCalls)]),
  };
}

/** Two lanes' runs of one journey, as one: the model's cost added, every flow kept. */
function mergeRuns(a: JourneyRun, b: JourneyRun): JourneyRun {
  const credits =
    a.credits === undefined && b.credits === undefined
      ? undefined
      : (a.credits ?? 0) + (b.credits ?? 0);
  const by = [JourneyBy.MODEL, JourneyBy.REPLAY].find((k) => k === a.by || k === b.by);
  return {
    id: a.id,
    ...(by === undefined ? {} : { by }),
    tokens: a.tokens + b.tokens,
    ...(credits === undefined ? {} : { credits }),
    flows: [...new Set([...a.flows, ...b.flows])],
  };
}

/** How a journey was answered, as its line says it: only what was measured. */
function byText(run: JourneyRun | undefined): string {
  if (run?.by === undefined) return '';
  return JourneyBy.REPLAY === run.by
    ? ' · replayed, no model tokens'
    : ` · driven by the model, ${String(run.tokens)} tokens`;
}

/** Why a journey whose end the page showed before it acted is not credited with it. */
const msgEndAlreadyShown = (end: string): string =>
  `"${end}" was already on the page before this journey acted, so reaching it proves nothing`;

/**
 * Whether a journey picks up where the one before it in its lane left off: it builds on one there
 * (`dependsOn`), or it looks at how one failed. Every other journey starts from the lane's start.
 */
function continuesLane(journey: Journey, before: ReadonlySet<string>): boolean {
  return (
    journey.dependsOn.some((id) => before.has(id)) ||
    (journey.when !== undefined &&
      JourneyOutcome.FAILED === journey.when.is &&
      before.has(journey.when.journey))
  );
}

/** What a drive that stopped short of its end state is sent back with. */
const continueGoal = (goal: string, end: string): string =>
  `${goal}\n\nContinue from the page you are on: it does not show "${end}" yet. ` +
  'Take the next step this journey names; do not start over.';

export async function runScript(
  script: DriveScript,
  ports: ScriptPorts,
  onChange: (view: PlanView) => void = () => undefined,
): Promise<ScriptRun> {
  const view = planView(script, Math.min(ports.parallel, script.maxParallel ?? ports.parallel));
  const toolCalls: ToolOutcome[] = [];
  const drives: HarnessResult[] = [];
  let stopped = false;
  const tell = (): void => {
    try {
      onChange(structuredClone(view));
    } catch {
      /* the picture of a drive is never a reason to stop it */
    }
  };

  // A journey that sits in several lanes is answered by the FIRST lane holding it; barriers wait on
  // that. It is answered with how it ended, because a condition can be waiting for a failure.
  const outcome = new Map<
    string,
    { promise: Promise<ScriptStatus>; settle: (status: ScriptStatus) => void }
  >();
  const firstLane = new Map<string, string>();
  for (const lane of script.lanes) {
    for (const id of lane.journeys) {
      if (firstLane.has(id)) continue;
      firstLane.set(id, lane.id);
      let settle: (status: ScriptStatus) => void = () => undefined;
      const promise = new Promise<ScriptStatus>((resolve) => (settle = resolve));
      outcome.set(id, { promise, settle });
    }
  }

  const journeyById = new Map(script.journeys.map((j) => [j.id, j]));
  /** Journeys whose checks may have held but whose goal the drive did not reach. */
  const goalMissed = new Set<object>();
  const broken = new Map<string, string>();
  /** Per card, for its line; per id, for the platform. */
  const runOf = new Map<object, JourneyRun>();
  const runs = new Map<string, JourneyRun>();
  tell();

  const runLane = async (lane: DriveScript['lanes'][number], laneIndex: number): Promise<void> => {
    const cards = view.lanes[laneIndex]?.journeys ?? [];
    const settleOwned = (id: string, status: ScriptStatus): void => {
      if (firstLane.get(id) === lane.id) outcome.get(id)?.settle(status);
    };
    let lease: { sessionId?: string; release(): Promise<void> } | undefined;
    let blocked = false;
    /** Where the lane's first journey started, and the journeys the lane has driven since. */
    let start: string | undefined;
    const driven = new Set<string>();
    try {
      for (const [position, id] of lane.journeys.entries()) {
        const card = cards[position];
        const journey = journeyById.get(id);
        if (card === undefined || journey === undefined) continue;
        const ended = (dep: string): Promise<ScriptStatus> =>
          outcome.get(dep)?.promise ?? Promise.resolve(ScriptStatus.BLOCKED);
        const waits = await Promise.all(barriersOf(script, lane.id, id).map(ended));
        // A conditional journey is decided by how the journey it names ended, not by the lane: a
        // failure earlier in the lane is often exactly what it is there to look at.
        const when = journey.when;
        const lanePast = when === undefined && blocked;
        if (
          lanePast ||
          stopped ||
          ports.stopped() ||
          waits.some((s) => ScriptStatus.PASSED !== s)
        ) {
          if (when === undefined) blocked = true;
          card.status = ScriptStatus.BLOCKED;
          settleOwned(id, ScriptStatus.BLOCKED);
          tell();
          continue;
        }
        if (when !== undefined && (await ended(when.journey)) !== when.is) {
          card.status = ScriptStatus.NOT_TAKEN;
          settleOwned(id, ScriptStatus.NOT_TAKEN);
          tell();
          continue;
        }
        lease ??= await ports.lease(lane.id);
        const raw = ports.toolset(lease.sessionId, journey.persona);
        // Unrecorded: where the journey starts is set-up, not something it drove or checked.
        // Kept for a journey with a fallback too: its goal starts where the journey began, not
        // on the page its own replays left (where the end may already show).
        if (0 === driven.size && (1 < lane.journeys.length || journey.fallback !== undefined))
          start = asString(
            asRecord(asRecord(await call(raw, ReticleTool.SNAPSHOT, {}))['status'])['route'],
          );
        else if (start !== undefined && !continuesLane(journey, driven))
          await call(raw, ReticleTool.NAVIGATE, { url: start });
        driven.add(id);
        // This journey's calls alone too: lanes share `toolCalls`, and its replays decide its fallback.
        const mine: ToolOutcome[] = [];
        const tools = recording(recording(raw, toolCalls), mine);
        card.status = ScriptStatus.RUNNING;
        tell();
        // This journey's own drives: lanes run side by side, so a slice of the shared list after the
        // await could hold another lane's missed goal and blame it on this journey.
        const own: HarnessResult[] = [];
        const stop = (): void => {
          stopped = true;
        };
        let ran = await runJourney(journey, card.steps, tools, ports, own, tell, stop);
        // Replay first: replays that decided nothing hand the journey's goal to the model. One that
        // failed is a regression, and a regression is reported, never re-driven into a pass.
        let refused: string | undefined;
        if (
          !ran.ok &&
          ran.notTaken === undefined &&
          journey.fallback !== undefined &&
          !ports.stopped() &&
          replaysDecidedNothing(mine)
        ) {
          refused = await ports.fallbackRefused?.();
          if (refused === undefined) {
            if (start !== undefined) await call(raw, ReticleTool.NAVIGATE, { url: start });
            ran = await runFallback(journey.fallback.goal, tools, ports, own, stop);
          }
        }
        const ok = ran.ok;
        // A drive the platform cut off (credits gone, a refusal, a 5xx) judged nothing: blocked, and
        // its reason said, never "failed" over an app nobody finished driving.
        const cutDrive = own.find((d) => StopReason.BROKEN === d.stopReason);
        const cut =
          refused === undefined ? cutDrive : { error: refused, stopReason: StopReason.BROKEN };
        if (cut !== undefined) broken.set(lane.id, cut.error ?? StopReason.BROKEN);
        card.status = ok
          ? ScriptStatus.PASSED
          : cut !== undefined
            ? ScriptStatus.BLOCKED
            : ran.notTaken !== undefined
              ? ScriptStatus.NOT_TAKEN
              : true === ran.undecided
                ? ScriptStatus.UNDECIDED
                : ScriptStatus.FAILED;
        if (ran.notTaken !== undefined) card.why = ran.notTaken;
        if (ran.why !== undefined) card.why = ran.why;
        drives.push(...own);
        const thisRun = journeyRun(id, mine, own);
        runOf.set(card, thisRun);
        const before = runs.get(id);
        runs.set(id, before === undefined ? thisRun : mergeRuns(before, thisRun));
        if (!ok && own.some((d) => false === d.goalMet)) goalMissed.add(card);
        // A conditional journey that failed leaves the lane as it found it: it was a side road.
        if (when === undefined) blocked = !ok;
        settleOwned(id, card.status);
        tell();
      }
    } catch (error) {
      // The lease or a tool broke the lane: everything it had not finished is blocked, and says why.
      const message = error instanceof Error ? error.message : String(error);
      broken.set(lane.id, message.split('\n')[0] ?? message);
      for (const card of cards) {
        if (ScriptStatus.PENDING === card.status || ScriptStatus.RUNNING === card.status) {
          card.status = ScriptStatus.BLOCKED;
        }
      }
      for (const id of lane.journeys) settleOwned(id, ScriptStatus.BLOCKED);
      tell();
    } finally {
      await lease?.release().catch(() => undefined);
    }
  };
  // Lanes start in order, `parallel` at a time: whatever a barrier waits on has already started.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < script.lanes.length; index = next++) {
      const lane = script.lanes[index];
      if (lane !== undefined) await runLane(lane, index);
    }
  };
  await Promise.all(Array.from({ length: view.parallel }, worker));

  const lines = view.lanes.flatMap((lane) =>
    lane.journeys.map((card) => {
      const why =
        ScriptStatus.BLOCKED === card.status
          ? broken.get(lane.id)
          : goalMissed.has(card)
            ? GOAL_NOT_REACHED
            : card.why;
      return `${mark(card.status)} ${lane.id} · ${card.title} — ${card.status}${why === undefined ? '' : ` (${why.slice(0, 160)})`}${byText(runOf.get(card))}`;
    }),
  );
  return {
    view,
    toolCalls,
    drives,
    stopped: stopped || ports.stopped(),
    lines,
    journeys: [...runs.values()],
  };
}

type StepCard = PlanView['lanes'][number]['journeys'][number]['steps'][number];

async function runJourney(
  journey: Journey,
  cards: StepCard[],
  tools: HarnessToolset,
  ports: ScriptPorts,
  drives: HarnessResult[],
  tell: () => void,
  stop: () => void,
): Promise<{ ok: boolean; notTaken?: string; why?: string; undecided?: true }> {
  const checkpoints = new Map<string, { flow: string; to: number }>();
  // One journey is one chain: a replay after the first continues the page the one before it left.
  let replayed = false;
  for (const [index, step] of journey.steps.entries()) {
    const card = cards[index];
    if (card === undefined) continue;
    if (ports.stopped()) {
      card.status = ScriptStatus.BLOCKED;
      tell();
      return { ok: false };
    }
    card.status = ScriptStatus.RUNNING;
    tell();
    let ok: boolean;
    let notTaken: string | undefined;
    let why: string | undefined;
    let undecided = false;
    try {
      if (ScriptStepKind.CHECKPOINT === step.kind) {
        checkpoints.set(step.id, step.reenter);
        ok = true;
      } else if (ScriptStepKind.BRANCH === step.kind) {
        ok = await runBranch(step, checkpoints.get(step.at), tools, ports, drives, stop);
      } else {
        ok = await runLeaf(step, tools, ports, drives, stop, replayed);
        if (ScriptStepKind.REPLAY === step.kind) replayed = true;
      }
    } catch (error) {
      if (error instanceof Undecided) {
        why = error.message;
        undecided = true;
      } else if (error instanceof StepNotTaken) notTaken = error.message;
      else throw error;
      ok = false;
    }
    card.status = ok
      ? ScriptStatus.PASSED
      : notTaken !== undefined
        ? ScriptStatus.NOT_TAKEN
        : undecided
          ? ScriptStatus.UNDECIDED
          : ScriptStatus.FAILED;
    tell();
    if (!ok) {
      for (const rest of cards.slice(index + 1)) rest.status = ScriptStatus.BLOCKED;
      tell();
      return {
        ok: false,
        ...(notTaken === undefined ? {} : { notTaken }),
        ...(why === undefined ? {} : { why }),
        ...(undecided ? { undecided: true as const } : {}),
      };
    }
  }
  return { ok: true };
}

/** The journey's goal, driven by the model in place of replays that decided nothing. */
async function runFallback(
  goal: string,
  tools: HarnessToolset,
  ports: ScriptPorts,
  drives: HarnessResult[],
  stop: () => void,
): Promise<{ ok: boolean; why?: string; undecided?: true }> {
  try {
    const ok = await runLeaf({ kind: ScriptStepKind.ACT, goal }, tools, ports, drives, stop);
    return ok ? { ok } : { ok, why: FELL_BACK };
  } catch (error) {
    if (error instanceof Undecided)
      return { ok: false, why: error.message, undecided: true as const };
    throw error;
  }
}

/** The guard stopped a destructive step nobody acknowledged: the step was not taken, not failed. */
class StepNotTaken extends Error {}

/** The journey ran and decided nothing: neither proved nor a failure of the app. */
class Undecided extends Error {}

/** The journey's end was on the page before it acted: undecided, never credited, no model spent. */
class EndAlreadyShown extends Undecided {}

/** Why a journey that reached its goal with no check that could go red proves nothing. */
const MSG_GOAL_WITHOUT_CHECK = 'it reached its goal, and no check could have gone red there';

/** What the guard's refusal names, as `drive-report.ts` reads it too. */
const DESTRUCTIVE_REFUSAL = 'confirmDangerous';
const MSG_NOT_TAKEN =
  'not taken: a step the flow marks destructive needs a person to acknowledge it (Run plan, Re-verify)';

/**
 * Every case drives from the checkpoint. The first starts where the journey already is; each later
 * one re-enters it first, so no case inherits the page the previous case left behind.
 */
async function runBranch(
  step: Extract<ScriptStep, { kind: 'branch' }>,
  reenter: { flow: string; to: number } | undefined,
  tools: HarnessToolset,
  ports: ScriptPorts,
  drives: HarnessResult[],
  stop: () => void,
): Promise<boolean> {
  let all = true;
  for (const [index, branchCase] of step.cases.entries()) {
    if (ports.stopped()) return false;
    if (0 < index) {
      if (reenter === undefined) return false;
      const back = await replay(tools, { flowName: reenter.flow, to: reenter.to });
      if (!back) return false;
    }
    if (branchCase.when !== undefined && !(await holds(tools, branchCase.when))) continue;
    for (const leaf of branchCase.steps) {
      if (!(await runLeaf(leaf, tools, ports, drives, stop))) {
        all = false;
        break;
      }
    }
  }
  return all;
}

async function runLeaf(
  step: ScriptLeafStep,
  tools: HarnessToolset,
  ports: ScriptPorts,
  drives: HarnessResult[],
  stop: () => void,
  /** A replay ran before this one in the journey: continue its page, never reload it. */
  chained = false,
): Promise<boolean> {
  switch (step.kind) {
    case ScriptStepKind.REPLAY:
      return replay(tools, {
        flowName: step.flow,
        ...(step.at === undefined ? (chained ? { at: 0 } : {}) : { at: step.at }),
        ...(step.to === undefined ? {} : { to: step.to }),
        // The flow's own steps, acknowledged by the person who started the run.
        ...(true === ports.confirmDangerous ? { [DESTRUCTIVE_REFUSAL]: true } : {}),
      });
    case ScriptStepKind.ASSERT:
      return holds(tools, step.predicate);
    case ScriptStepKind.ACT: {
      if (step.goal !== undefined) {
        const budget = step.maxSteps ?? OPEN_GOAL_STEPS;
        // Parsed before the drive: an end the page already shows is already true, never proved.
        const ending = parseGoals(step.goal)
          .filter((g) => true !== g.absent)
          .at(-1)?.text;
        if (ending !== undefined && (await lookFor(tools.invoke.bind(tools), ending, ports.own)))
          throw new EndAlreadyShown(msgEndAlreadyShown(ending));
        let drive = await ports.drive(tools, step.goal, budget);
        drives.push(drive);
        if (StopReason.STOPPED === drive.stopReason) stop();
        // Passed means its checks held, not that it ran one: a refund journey whose two checks both
        // failed was marked passed because a check had run.
        if (0 < checkTally(drive.toolCalls).failed) return false;
        // A goal that quotes where it ends is judged there, by an assert kept as the run's check:
        // the model clicked a counter with no `until` and the journey failed on a counter that worked.
        // ponytail: the LAST quote the goal does not negate is the end state ("from "count: 0" to
        // "count: 1""); a goal that quotes its end first needs the planner to say which is the end.
        const end = ending;
        if (end === undefined) {
          if (0 < checkTally(drive.toolCalls).held) return false !== drive.goalMet;
          // Reached, by its own word, with nothing checked: not proved, and not a failure either.
          if (true === drive.goalMet) throw new Undecided(MSG_GOAL_WITHOUT_CHECK);
          return false;
        }
        let shown = await lookFor(tools.invoke.bind(tools), end, ports.own);
        // A drive that finished with turns to spare, short of the end its own plan names (joined,
        // opened Runs, never clicked Team), is sent on once from where it stands, not graded there.
        const left = budget - drive.steps;
        if (!shown && StopReason.FINISHED === drive.stopReason && MIN_CONTINUE_STEPS <= left) {
          drive = await ports.drive(tools, continueGoal(step.goal, end), left);
          drives.push(drive);
          if (StopReason.STOPPED === drive.stopReason) stop();
          if (0 < checkTally(drive.toolCalls).failed) return false;
          shown = await lookFor(tools.invoke.bind(tools), end, ports.own);
        }
        // Never reached is the journey's miss, not a failed check on the app: no assert is kept. The
        // page decides it, not the driver's word: an end the page shows was reached, whatever the
        // driver said (a drive started on a dead link reached it and was failed on its own "no").
        if (!shown) return false;
        return holds(tools, { kind: PredicateKind.TEXT, contains: end });
      }
      const result = await call(tools, ReticleTool.ACT_AND_WAIT, {
        ...(step.target === undefined ? {} : { target: step.target }),
        action: step.action,
        ...(step.args === undefined ? {} : { args: step.args }),
        ...(step.until === undefined ? {} : { until: step.until }),
      });
      return Verified.YES === asRecord(result)['verified'];
    }
  }
}

async function replay(tools: HarnessToolset, args: Record<string, unknown>): Promise<boolean> {
  const result = asRecord(await call(tools, ReticleTool.FLOW_REPLAY, args));
  if (ReplayStatus.OK === result['status']) return true;
  const error = result['error'];
  const message = asString(error) ?? asString(asRecord(error)['message']) ?? '';
  if (message.includes(DESTRUCTIVE_REFUSAL)) throw new StepNotTaken(MSG_NOT_TAKEN);
  const [outcome] = replayedFlows([
    { id: 'replay', name: ReticleTool.FLOW_REPLAY, args, result, isError: false },
  ]);
  if (UNDECIDED_REPLAY.has(outcome?.status))
    throw new Undecided(msgReplayUndecided(String(args['flowName'])));
  return false;
}

async function holds(tools: HarnessToolset, predicate: unknown): Promise<boolean> {
  return true === asRecord(await call(tools, ReticleTool.ASSERT, { predicate }))['pass'];
}

/** A tool that throws is a failed step, not a crashed run. */
async function call(
  tools: HarnessToolset,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await tools.invoke(name, args);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The toolset, with every call kept, so the run's report reads them like a model drive's. */
function recording(tools: HarnessToolset, into: ToolOutcome[]): HarnessToolset {
  return {
    tools: tools.tools,
    async invoke(name, args) {
      const id = `script-${String(into.length + 1)}`;
      try {
        const result = await tools.invoke(name, args);
        into.push({ id, name, args, result, isError: false });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        into.push({ id, name, args, result: { error: message }, isError: true });
        throw error;
      }
    },
  };
}

/** The HUD's picture of a script before anything ran. */
export function planView(script: DriveScript, parallel: number): PlanView {
  const byId = new Map(script.journeys.map((j) => [j.id, j]));
  return {
    parallel: Math.max(1, Math.min(parallel, script.lanes.length)),
    lanes: script.lanes.map((lane) => ({
      id: lane.id,
      journeys: lane.journeys.flatMap((id) => {
        const journey = byId.get(id);
        if (journey === undefined) return [];
        return [
          {
            id,
            title: journey.title,
            ...(journey.persona === undefined ? {} : { persona: journey.persona }),
            waitsOn: barriersOf(script, lane.id, id),
            status: ScriptStatus.PENDING,
            steps: journey.steps.map((step) => ({
              label: stepLabel(step),
              status: ScriptStatus.PENDING,
            })),
          },
        ];
      }),
    })),
  };
}

function mark(status: string): string {
  if (ScriptStatus.PASSED === status) return '✓';
  if (ScriptStatus.FAILED === status) return '✗';
  return '○';
}
