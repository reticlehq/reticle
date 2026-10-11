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
  JourneyOutcome,
  ScriptStepKind,
  barriersOf,
  stepLabel,
  type DriveScript,
  type Journey,
  type ScriptLeafStep,
  type ScriptStep,
} from '@reticlehq/core/artifacts';
import { checkTally } from '../drive-report.js';
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
}

/** Why a journey failed when its goal, not a check, is what was missing. */
const GOAL_NOT_REACHED = 'the goal was not reached, though its checks may have held';

/** A planned open journey gets the same budget a named persona drive gets. */
const OPEN_GOAL_STEPS = DEFAULT_MAX_STEPS;

/** Fewer model turns left than this and a continuation could not take the step it is sent for. */
const MIN_CONTINUE_STEPS = 3;

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
        if (0 === driven.size && 1 < lane.journeys.length)
          start = asString(
            asRecord(asRecord(await call(raw, ReticleTool.SNAPSHOT, {}))['status'])['route'],
          );
        else if (start !== undefined && !continuesLane(journey, driven))
          await call(raw, ReticleTool.NAVIGATE, { url: start });
        driven.add(id);
        const tools = recording(raw, toolCalls);
        card.status = ScriptStatus.RUNNING;
        tell();
        // This journey's own drives: lanes run side by side, so a slice of the shared list after the
        // await could hold another lane's missed goal and blame it on this journey.
        const own: HarnessResult[] = [];
        const ran = await runJourney(journey, card.steps, tools, ports, own, tell, () => {
          stopped = true;
        });
        const ok = ran.ok;
        // A drive the platform cut off (credits gone, a refusal, a 5xx) judged nothing: blocked, and
        // its reason said, never "failed" over an app nobody finished driving.
        const cut = own.find((d) => StopReason.BROKEN === d.stopReason);
        if (cut !== undefined) broken.set(lane.id, cut.error ?? StopReason.BROKEN);
        card.status = ok
          ? ScriptStatus.PASSED
          : cut !== undefined
            ? ScriptStatus.BLOCKED
            : ran.notTaken !== undefined
              ? ScriptStatus.NOT_TAKEN
              : ScriptStatus.FAILED;
        if (ran.notTaken !== undefined) card.why = ran.notTaken;
        if (ran.why !== undefined) card.why = ran.why;
        drives.push(...own);
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
      return `${mark(card.status)} ${lane.id} · ${card.title} — ${card.status}${why === undefined ? '' : ` (${why.slice(0, 160)})`}`;
    }),
  );
  return { view, toolCalls, drives, stopped: stopped || ports.stopped(), lines };
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
): Promise<{ ok: boolean; notTaken?: string; why?: string }> {
  const checkpoints = new Map<string, { flow: string; to: number }>();
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
    try {
      if (ScriptStepKind.CHECKPOINT === step.kind) {
        checkpoints.set(step.id, step.reenter);
        ok = true;
      } else if (ScriptStepKind.BRANCH === step.kind) {
        ok = await runBranch(step, checkpoints.get(step.at), tools, ports, drives, stop);
      } else {
        ok = await runLeaf(step, tools, ports, drives, stop);
      }
    } catch (error) {
      if (error instanceof EndAlreadyShown) why = error.message;
      else if (error instanceof StepNotTaken) notTaken = error.message;
      else throw error;
      ok = false;
    }
    card.status = ok
      ? ScriptStatus.PASSED
      : notTaken === undefined
        ? ScriptStatus.FAILED
        : ScriptStatus.NOT_TAKEN;
    tell();
    if (!ok) {
      for (const rest of cards.slice(index + 1)) rest.status = ScriptStatus.BLOCKED;
      tell();
      return {
        ok: false,
        ...(notTaken === undefined ? {} : { notTaken }),
        ...(why === undefined ? {} : { why }),
      };
    }
  }
  return { ok: true };
}

/** The guard stopped a destructive step nobody acknowledged: the step was not taken, not failed. */
class StepNotTaken extends Error {}

/** The journey's end was on the page before it acted: failed, never credited, and no model spent. */
class EndAlreadyShown extends Error {}

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
): Promise<boolean> {
  switch (step.kind) {
    case ScriptStepKind.REPLAY:
      return replay(tools, {
        flowName: step.flow,
        ...(step.at === undefined ? {} : { at: step.at }),
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
        if (end === undefined)
          return false !== drive.goalMet && 0 < checkTally(drive.toolCalls).held;
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
        // Never reached is the journey's miss, not a failed check on the app: no assert is kept.
        if (!shown || false === drive.goalMet) return false;
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
