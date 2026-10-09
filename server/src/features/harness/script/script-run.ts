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
  type PlanView,
} from '@reticlehq/core';
import {
  ScriptStepKind,
  barriersOf,
  stepLabel,
  type DriveScript,
  type Journey,
  type ScriptLeafStep,
  type ScriptStep,
} from '@reticlehq/core/artifacts';
import { checkTally } from '../drive-report.js';
import { goalsIn } from '../goals.js';
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

  // A journey that sits in several lanes is answered by the FIRST lane holding it; barriers wait on that.
  const outcome = new Map<string, { promise: Promise<boolean>; settle: (ok: boolean) => void }>();
  const firstLane = new Map<string, string>();
  for (const lane of script.lanes) {
    for (const id of lane.journeys) {
      if (firstLane.has(id)) continue;
      firstLane.set(id, lane.id);
      let settle: (ok: boolean) => void = () => undefined;
      const promise = new Promise<boolean>((resolve) => (settle = resolve));
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
    const settleOwned = (id: string, ok: boolean): void => {
      if (firstLane.get(id) === lane.id) outcome.get(id)?.settle(ok);
    };
    let lease: { sessionId?: string; release(): Promise<void> } | undefined;
    let blocked = false;
    try {
      for (const [position, id] of lane.journeys.entries()) {
        const card = cards[position];
        const journey = journeyById.get(id);
        if (card === undefined || journey === undefined) continue;
        const waits = await Promise.all(
          barriersOf(script, lane.id, id).map(
            (dep) => outcome.get(dep)?.promise ?? Promise.resolve(false),
          ),
        );
        if (blocked || stopped || ports.stopped() || waits.includes(false)) {
          blocked = true;
          card.status = ScriptStatus.BLOCKED;
          settleOwned(id, false);
          tell();
          continue;
        }
        lease ??= await ports.lease(lane.id);
        const tools = recording(ports.toolset(lease.sessionId, journey.persona), toolCalls);
        card.status = ScriptStatus.RUNNING;
        tell();
        // This journey's own drives: lanes run side by side, so a slice of the shared list after the
        // await could hold another lane's missed goal and blame it on this journey.
        const own: HarnessResult[] = [];
        const ok = await runJourney(journey, card.steps, tools, ports, own, tell, () => {
          stopped = true;
        });
        // A drive the platform cut off (credits gone, a refusal, a 5xx) judged nothing: blocked, and
        // its reason said, never "failed" over an app nobody finished driving.
        const cut = own.find((d) => StopReason.BROKEN === d.stopReason);
        if (cut !== undefined) broken.set(lane.id, cut.error ?? StopReason.BROKEN);
        card.status = ok
          ? ScriptStatus.PASSED
          : cut === undefined
            ? ScriptStatus.FAILED
            : ScriptStatus.BLOCKED;
        drives.push(...own);
        if (!ok && own.some((d) => false === d.goalMet)) goalMissed.add(card);
        blocked = !ok;
        settleOwned(id, ok);
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
      for (const id of lane.journeys) settleOwned(id, false);
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
            : undefined;
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
): Promise<boolean> {
  const checkpoints = new Map<string, { flow: string; to: number }>();
  for (const [index, step] of journey.steps.entries()) {
    const card = cards[index];
    if (card === undefined) continue;
    if (ports.stopped()) {
      card.status = ScriptStatus.BLOCKED;
      tell();
      return false;
    }
    card.status = ScriptStatus.RUNNING;
    tell();
    let ok: boolean;
    if (ScriptStepKind.CHECKPOINT === step.kind) {
      checkpoints.set(step.id, step.reenter);
      ok = true;
    } else if (ScriptStepKind.BRANCH === step.kind) {
      ok = await runBranch(step, checkpoints.get(step.at), tools, ports, drives, stop);
    } else {
      ok = await runLeaf(step, tools, ports, drives, stop);
    }
    card.status = ok ? ScriptStatus.PASSED : ScriptStatus.FAILED;
    tell();
    if (!ok) {
      for (const rest of cards.slice(index + 1)) rest.status = ScriptStatus.BLOCKED;
      tell();
      return false;
    }
  }
  return true;
}

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
      });
    case ScriptStepKind.ASSERT:
      return holds(tools, step.predicate);
    case ScriptStepKind.ACT: {
      if (step.goal !== undefined) {
        const drive = await ports.drive(tools, step.goal, step.maxSteps ?? OPEN_GOAL_STEPS);
        drives.push(drive);
        if (StopReason.STOPPED === drive.stopReason) stop();
        // Passed means its checks held, not that it ran one: a refund journey whose two checks both
        // failed was marked passed because a check had run.
        const tally = checkTally(drive.toolCalls);
        if (0 < tally.failed || false === drive.goalMet) return false;
        // A goal that quotes where it ends is judged there, by an assert kept as the run's check:
        // the model clicked a counter with no `until` and the journey failed on a counter that worked.
        // ponytail: the LAST quote is the end state ("from "count: 0" to "count: 1""); a goal that
        // quotes its end first needs the planner to say which quote is the end.
        const end = goalsIn(step.goal).at(-1);
        if (end !== undefined) return holds(tools, { kind: PredicateKind.TEXT, contains: end });
        return 0 < tally.held;
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
  return ReplayStatus.OK === asRecord(await call(tools, ReticleTool.FLOW_REPLAY, args))['status'];
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
