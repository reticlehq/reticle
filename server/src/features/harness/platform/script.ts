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
  StepEffect,
  type FlowFile,
  type FlowStep,
  type PlanView,
} from '@reticlehq/core';
import { DriveScriptSchema, checkScript, type DriveScript } from '@reticlehq/core/artifacts';

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

export async function proposeScript(
  platform: { url: string; apiKey: string },
  ask: ScriptAsk,
  doFetch: FetchLike = (url, init) => fetch(url, init),
): Promise<{ script: DriveScript; planId?: string } | undefined> {
  try {
    const res = await doFetch(`${platform.url}${SCRIPTS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${platform.apiKey}` },
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
        goals: ask.goals,
        gaps: ask.gaps,
        rules: ask.rules,
        ...(ask.personas === undefined || 0 === ask.personas.length
          ? {}
          : { personas: ask.personas }),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { script?: unknown; planId?: unknown };
    const parsed = DriveScriptSchema.safeParse(body.script);
    if (!parsed.success || 0 < checkScript(parsed.data).length) return undefined;
    return {
      script: parsed.data,
      ...('string' === typeof body.planId ? { planId: body.planId } : {}),
    };
  } catch {
    return undefined;
  }
}

/** One journey's outcome, as the platform keeps it beside the plan. */
export interface JourneyResult {
  id: string;
  title: string;
  status: ScriptStatus;
}

/** Worst first: a journey that ran in two lanes reports the worse of the two. */
const SEVERITY: readonly ScriptStatus[] = [
  ScriptStatus.FAILED,
  ScriptStatus.BLOCKED,
  ScriptStatus.RUNNING,
  ScriptStatus.PENDING,
  ScriptStatus.NOT_TAKEN,
  ScriptStatus.PASSED,
];

/** How each journey of a run plan went, once each. */
export function journeyResults(view: PlanView): JourneyResult[] {
  const byId = new Map<string, JourneyResult>();
  for (const lane of view.lanes)
    for (const card of lane.journeys) {
      const seen = byId.get(card.id);
      if (seen === undefined || SEVERITY.indexOf(card.status) < SEVERITY.indexOf(seen.status))
        byId.set(card.id, { id: card.id, title: card.title, status: card.status });
    }
  return [...byId.values()];
}

/** Tell the platform how its plan went. A failure costs the next plan its memory, never this run. */
export async function reportPlanResults(
  platform: { url: string; apiKey: string },
  planId: string,
  results: readonly JourneyResult[],
  doFetch: FetchLike = (url, init) => fetch(url, init),
): Promise<boolean> {
  try {
    const res = await doFetch(
      `${platform.url}${SCRIPTS_PATH}/${encodeURIComponent(planId)}${RESULTS_PATH}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${platform.apiKey}` },
        body: JSON.stringify({ results }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}
