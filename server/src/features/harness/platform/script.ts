/**
 * The drive plan, asked of the platform.
 *
 * The platform plans the whole drive: it proposes the personas, orders the saved flows, finds the
 * shared starts to branch from and writes the product's rules into each open journey. What it is
 * sent is what the project already knows, and each saved step goes as a short hash, never its values,
 * which is all a plan needs to tell two steps apart.
 *
 * The answer is not trusted: it must parse as a drive script and pass the same checks a local plan
 * does, or it is dropped and the daemon plans locally.
 *
 * The platform keeps every plan under an id, and is told afterwards how each journey went: that is
 * what the next plan learns from (what failed is driven first).
 */
import { createHash } from 'node:crypto';
import {
  ScriptStatus,
  asRecord,
  asString,
  StepEffect,
  type FlowFile,
  type FlowStep,
  type PlanView,
} from '@reticlehq/core';
import {
  DriveScriptSchema,
  ScriptStepKind,
  type JourneyBy,
  checkScript,
  type DriveScript,
} from '@reticlehq/core/artifacts';
import { platformHeaders, type PlatformCredential } from './server-driver.js';

const SCRIPTS_PATH = '/v1/harness/scripts';
const RESULTS_PATH = '/results';
const TIMEOUT_MS = 90_000;
/** Characters of a step hash: enough to tell a flow's steps apart, too few to carry anything. */
const STEP_HASH_CHARS = 12;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ScriptAsk {
  about: string;
  flows: readonly FlowFile[];
  replay: readonly string[];
  goals: readonly string[];
  gaps: readonly string[];
  rules: readonly string[];
  /** Personas the project already drove; the platform proposes new ones only when there are none. */
  personas?: readonly { name: string; journey: string }[];
}

/** How long a persona's name may be, read back out of a flow's intent. */
const MAX_PERSONA_NAME = 80;
const MAX_PERSONAS = 5;

/**
 * The personas earlier drives used, read from their flows' intents (`Name: journey`). Proposed
 * afresh on every run, they were different people each time, so each run's flows had new names
 * and the old ones were never replayed or updated.
 */
export function personasIn(flows: readonly FlowFile[]): { name: string; journey: string }[] {
  const seen = new Map<string, string>();
  for (const flow of flows) {
    // The first line only: an older drive saved the product's rules below the journey.
    const intent = (flow.intent ?? '').split('\n')[0] ?? '';
    const at = intent.indexOf(':');
    if (at <= 0 || MAX_PERSONA_NAME < at) continue;
    const name = intent.slice(0, at).trim();
    const journey = intent.slice(at + 1).trim();
    if (0 < name.length && 0 < journey.length && !seen.has(name)) seen.set(name, journey);
  }
  return [...seen].slice(0, MAX_PERSONAS).map(([name, journey]) => ({ name, journey }));
}

/** Equal for two steps that drive the same control the same way; the values never leave. */
export function stepHash(step: FlowStep): string {
  return createHash('sha256')
    .update(
      JSON.stringify([step.tool, step.anchor, step.action, step.args, step.steps, step.invoke]),
    )
    .digest('hex')
    .slice(0, STEP_HASH_CHARS);
}

/** What a run that names nothing asks for: the whole app, which the platform splits into journeys. */
export const WHOLE_APP_REQUEST = 'Test my app: plan the journeys this app offers and drive them';

/**
 * The goals a plan request carries. The platform refuses one that names nothing — no journey, no
 * persona, nothing to replay — and no longer invents personas, so such a run asks for the whole app.
 */
function goalsToAsk(ask: ScriptAsk): readonly string[] {
  const named = 0 < ask.goals.length || 0 < ask.replay.length || 0 < (ask.personas?.length ?? 0);
  return named ? ask.goals : [WHOLE_APP_REQUEST];
}

export async function proposeScript(
  platform: PlatformCredential,
  ask: ScriptAsk,
  doFetch: FetchLike = (url, init) => fetch(url, init),
): Promise<
  { script: DriveScript; planId?: string; creditsSpent?: number } | { refused: string } | undefined
> {
  try {
    const res = await doFetch(`${platform.url}${SCRIPTS_PATH}`, {
      method: 'POST',
      headers: platformHeaders(platform),
      body: JSON.stringify({
        about: ask.about,
        flows: ask.flows.map((flow) => ({
          name: flow.name,
          ...(flow.intent === undefined ? {} : { intent: flow.intent }),
          needs: flow.needs ?? [],
          steps: flow.steps.map(stepHash),
          commits: flow.steps.flatMap((step, i) => (StepEffect.COMMITS === step.effect ? [i] : [])),
          // How much it proves: a journey whose flows assert nothing is driven again, not replayed.
          checks: flow.steps.filter(
            (step) =>
              step.expect !== undefined || true === step.steps?.some((s) => s.expect !== undefined),
          ).length,
        })),
        replay: ask.replay,
        goals: goalsToAsk(ask),
        gaps: ask.gaps,
        rules: ask.rules,
        ...(ask.personas === undefined || 0 === ask.personas.length
          ? {}
          : { personas: ask.personas }),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The platform's own reason, so a drive that goes on without a plan can say why.
    if (!res.ok) return { refused: await refusalOf(res) };
    const body = (await res.json()) as {
      script?: unknown;
      planId?: unknown;
      creditsSpent?: unknown;
    };
    const parsed = DriveScriptSchema.safeParse(body.script);
    if (!parsed.success || 0 < checkScript(parsed.data).length) return undefined;
    return {
      script: parsed.data,
      ...('string' === typeof body.planId ? { planId: body.planId } : {}),
      // What writing the plan cost: part of the run's spend, not free.
      ...('number' === typeof body.creditsSpent ? { creditsSpent: body.creditsSpent } : {}),
    };
  } catch {
    return undefined;
  }
}

async function refusalOf(res: Response): Promise<string> {
  try {
    const message = ((await res.json()) as { error?: { message?: unknown } }).error?.message;
    if ('string' === typeof message && 0 < message.length) return message;
  } catch {
    // not JSON: the status says enough
  }
  return `the platform answered ${String(res.status)}`;
}

/**
 * A plan the platform saved, as it stands now: somebody may have edited it on the dashboard since it
 * last ran. Checked like a proposed one; `undefined` when it cannot be read or cannot run.
 */
export async function fetchScript(
  platform: PlatformCredential,
  planId: string,
  doFetch: FetchLike = (url, init) => fetch(url, init),
): Promise<DriveScript | undefined> {
  try {
    const res = await doFetch(`${platform.url}${SCRIPTS_PATH}/${encodeURIComponent(planId)}`, {
      method: 'GET',
      headers: platformHeaders(platform),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const plan = (await res.json()) as { script?: unknown };
    const parsed = DriveScriptSchema.safeParse(plan.script);
    return parsed.success && 0 === checkScript(parsed.data).length
      ? replayFirst(parsed.data, plan)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A rerun replays what passed before. A journey the plan's history shows passing, with the flows it
 * saved, replays those flows; the model drives its goal only when they decide nothing (`fallback`),
 * and a replay that fails is a regression, never re-driven. A rerun re-drove a journey that had
 * passed, at a model's cost, and failed it twice. Journeys that already replay are left as planned.
 */
export function replayFirst(script: DriveScript, plan: unknown): DriveScript {
  const passedFlows = new Map<string, string[]>();
  const record = asRecord(plan);
  const runs = Array.isArray(record['runs']) ? record['runs'] : [];
  const batches = [...runs.map((run) => asRecord(run)['results']), record['results']];
  for (const batch of batches) {
    if (!Array.isArray(batch)) continue;
    for (const raw of batch) {
      const result = asRecord(raw);
      const id = asString(result['id']);
      const flows = Array.isArray(result['flows'])
        ? result['flows'].filter((f): f is string => 'string' === typeof f && 0 < f.length)
        : [];
      if (id !== undefined && ScriptStatus.PASSED === result['status'] && 0 < flows.length)
        passedFlows.set(id, flows);
    }
  }
  if (0 === passedFlows.size) return script;
  return {
    ...script,
    journeys: script.journeys.map((journey) => {
      const flows = passedFlows.get(journey.id);
      const goals = journey.steps.map((step) =>
        ScriptStepKind.ACT === step.kind ? step.goal : undefined,
      );
      if (flows === undefined || journey.fallback !== undefined || goals.includes(undefined))
        return journey;
      return {
        ...journey,
        steps: flows.map((flow) => ({ kind: ScriptStepKind.REPLAY, flow })),
        fallback: { goal: goals.join('; ') },
      };
    }),
  };
}

/** One journey's outcome, as the platform keeps it beside the plan. */
export interface JourneyResult {
  id: string;
  title: string;
  status: ScriptStatus;
  /** What happened, in a line: why a journey that never ran was blocked. */
  line?: string;
  /** Replayed with no model, or driven by it. Absent for a journey that never ran. */
  by?: JourneyBy;
  /** Model tokens it spent; 0 for a pure replay. */
  tokens?: number;
  /** Credits its model drives spent, when the platform said. */
  credits?: number;
  /** The flows it replayed or recorded: the platform links the journey to these. */
  flows?: string[];
  /** Whether the goals the run was asked were reached, once graded. Absent when none were judged. */
  goalMet?: boolean;
}

/** How one journey that ran was answered, from the run (`JourneyRun`). */
export interface JourneyAnswer {
  id: string;
  by?: JourneyBy;
  tokens: number;
  credits?: number;
  flows: string[];
}

/**
 * The plan only replays saved flows: no step anywhere, branch cases included, hands the model
 * anything to do. Such a run spends no model turns, so the gates that guard a model drive do not
 * apply to it.
 */
export function drivesNothing(script: DriveScript): boolean {
  return script.journeys.every((journey) =>
    journey.steps.every((step) =>
      ScriptStepKind.BRANCH === step.kind
        ? step.cases.every((c) => c.steps.every((leaf) => ScriptStepKind.ACT !== leaf.kind))
        : ScriptStepKind.ACT !== step.kind,
    ),
  );
}

/** The saved plan reads as one that only replays saved flows. Unreadable: not known to, so false. */
export async function savedPlanDrivesNothing(
  platform: PlatformCredential,
  planId: string,
  doFetch: FetchLike = (url, init) => fetch(url, init),
): Promise<boolean> {
  const script = await fetchScript(platform, planId, doFetch);
  return script !== undefined && drivesNothing(script);
}

/**
 * A saved plan the run was refused for, or that broke before any journey ran, told to the plan
 * anyway: every journey blocked, with the reason, so the plan's history records the attempt instead
 * of showing nothing. Best-effort, like every report to the plan.
 */
export async function reportPlanBlocked(
  platform: PlatformCredential,
  planId: string,
  reason: string,
  doFetch: FetchLike = (url, init) => fetch(url, init),
): Promise<boolean> {
  const script = await fetchScript(platform, planId, doFetch);
  const results = (script?.journeys ?? []).map((journey) => ({
    id: journey.id,
    title: journey.title,
    status: ScriptStatus.BLOCKED,
    line: reason,
  }));
  return reportPlanResults(platform, planId, results, [], doFetch);
}

/** Worst first: a journey that ran in two lanes reports the worse of the two. */
const SEVERITY: readonly ScriptStatus[] = [
  ScriptStatus.FAILED,
  ScriptStatus.BLOCKED,
  ScriptStatus.RUNNING,
  ScriptStatus.PENDING,
  ScriptStatus.UNDECIDED,
  ScriptStatus.NOT_TAKEN,
  ScriptStatus.PASSED,
];

/** How each journey of a run plan went, once each, matched to how it was answered by id. */
export function journeyResults(
  view: PlanView,
  answers: readonly JourneyAnswer[] = [],
): JourneyResult[] {
  const byId = new Map<string, JourneyResult>();
  for (const lane of view.lanes)
    for (const card of lane.journeys) {
      const seen = byId.get(card.id);
      if (seen === undefined || SEVERITY.indexOf(card.status) < SEVERITY.indexOf(seen.status))
        byId.set(card.id, {
          id: card.id,
          title: card.title,
          status: card.status,
          ...(card.why === undefined ? {} : { line: card.why }),
        });
    }
  const answered = new Map(answers.map((a) => [a.id, a]));
  return [...byId.values()].map((result) => {
    const answer = answered.get(result.id);
    if (answer === undefined) return result;
    return {
      ...result,
      ...(answer.by === undefined ? {} : { by: answer.by }),
      tokens: answer.tokens,
      ...(answer.credits === undefined ? {} : { credits: answer.credits }),
      ...(0 === answer.flows.length ? {} : { flows: [...answer.flows] }),
    };
  });
}

/** Tell the platform how its plan went. A failure costs the next plan its memory, never this run. */
export async function reportPlanResults(
  platform: PlatformCredential,
  planId: string,
  results: readonly JourneyResult[],
  runIds: readonly string[] = [],
  doFetch: FetchLike = (url, init) => fetch(url, init),
): Promise<boolean> {
  try {
    const res = await doFetch(
      `${platform.url}${SCRIPTS_PATH}/${encodeURIComponent(planId)}${RESULTS_PATH}`,
      {
        method: 'POST',
        headers: platformHeaders(platform),
        // The runs it made, so the plan's history opens each one.
        body: JSON.stringify({ results, ...(0 === runIds.length ? {} : { runIds }) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}
