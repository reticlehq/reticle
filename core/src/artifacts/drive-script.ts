/**
 * A drive script: the Harness's plan, written down before it drives, in a language small enough to
 * check.
 *
 * Journeys say WHAT to drive: replay a saved flow (deterministic, no model), act and wait on one
 * exact control, hand an open goal to the model, assert a consequence. Lanes say HOW: each lane is
 * one browser context driven in order, and lanes run side by side. A journey that needs another one
 * either follows it in the same lane (and inherits its page) or waits on it from a later lane (a
 * barrier: it starts once that journey passed, and is blocked if it failed).
 *
 * A checkpoint names a point a journey can come back to, and how: replay a flow up to a step. A
 * branch drives several cases from that point; every case after the first re-enters it first, so
 * each case starts from the same page and not from wherever the previous case left it.
 *
 * Daemon-side only: the HUD draws a plan from a flat view of it (`PlanView`), never this schema.
 */
import { z } from 'zod';
import { PredicateSchema } from '../verdict/predicate.js';

export const ScriptStepKind = {
  REPLAY: 'replay',
  ACT: 'act',
  ASSERT: 'assert',
  CHECKPOINT: 'checkpoint',
  BRANCH: 'branch',
} as const;

export const ScriptSource = { LOCAL: 'local', PLATFORM: 'platform' } as const;

const ReplayStep = z.object({
  kind: z.literal(ScriptStepKind.REPLAY),
  flow: z.string().min(1),
  /** Continue at this step on the page as it is: a branch case picking up at its checkpoint. */
  at: z.number().int().positive().optional(),
  /** Stop before this step. Absent: the whole flow. */
  to: z.number().int().positive().optional(),
});

const ActStep = z
  .object({
    kind: z.literal(ScriptStepKind.ACT),
    /** Exact: a target, an action and the consequence that must follow. */
    target: z.record(z.string(), z.unknown()).optional(),
    action: z.string().min(1).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    until: PredicateSchema.optional(),
    /** Open: what the model should accomplish, in plain words. */
    goal: z.string().min(1).optional(),
    maxSteps: z.number().int().positive().max(40).optional(),
  })
  .refine((step) => (step.action === undefined) !== (step.goal === undefined), {
    message: 'an act step is exact (`action`) or open (`goal`), never both and never neither',
  });

const AssertStep = z.object({ kind: z.literal(ScriptStepKind.ASSERT), predicate: PredicateSchema });

const CheckpointStep = z.object({
  kind: z.literal(ScriptStepKind.CHECKPOINT),
  id: z.string().min(1),
  /** How to get back here: replay this flow up to (not including) step `to`. */
  reenter: z.object({ flow: z.string().min(1), to: z.number().int().positive() }),
});

const LeafStep = z.union([ReplayStep, ActStep, AssertStep]);

const BranchStep = z.object({
  kind: z.literal(ScriptStepKind.BRANCH),
  /** The checkpoint every case starts from. */
  at: z.string().min(1),
  cases: z
    .array(
      z.object({
        label: z.string().min(1),
        /** Taken only when this holds once the checkpoint is re-entered. Absent: always taken. */
        when: PredicateSchema.optional(),
        steps: z.array(LeafStep).min(1),
      }),
    )
    .min(2),
});

export const ScriptStepSchema = z.union([LeafStep, CheckpointStep, BranchStep]);

export const JourneySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  persona: z.string().optional(),
  dependsOn: z.array(z.string()).default([]),
  steps: z.array(ScriptStepSchema).min(1),
});

export const LaneSchema = z.object({
  id: z.string().min(1),
  /** Driven in this order, in one browser context. */
  journeys: z.array(z.string()).min(1),
});

export const DriveScriptSchema = z.object({
  version: z.literal(1),
  source: z.enum([ScriptSource.LOCAL, ScriptSource.PLATFORM]),
  personas: z.array(z.object({ name: z.string(), journey: z.string() })).default([]),
  journeys: z.array(JourneySchema),
  lanes: z.array(LaneSchema),
  /** At most this many lanes at once. Absent: as many as the browser pool can lease. */
  maxParallel: z.number().int().positive().optional(),
});

export type ScriptStep = z.infer<typeof ScriptStepSchema>;
export type ScriptLeafStep = z.infer<typeof LeafStep>;
export type Journey = z.infer<typeof JourneySchema>;
export type Lane = z.infer<typeof LaneSchema>;
export type DriveScript = z.infer<typeof DriveScriptSchema>;

/**
 * Every reason this script cannot run as written, or none.
 *
 * A dependency is honoured one of two ways: earlier in the same lane, or in an EARLIER lane (a
 * barrier). Pointing only backwards is what makes a script acyclic and a barrier unable to wait on
 * a lane that has not started, so no separate cycle check is needed.
 */
export function checkScript(script: DriveScript): string[] {
  const problems: string[] = [];
  const byId = new Map<string, Journey>();
  for (const journey of script.journeys) {
    if (byId.has(journey.id)) problems.push(`journey "${journey.id}" is declared twice`);
    byId.set(journey.id, journey);
  }
  const placed = new Set(script.lanes.flatMap((lane) => lane.journeys));
  for (const journey of script.journeys) {
    if (!placed.has(journey.id)) problems.push(`journey "${journey.id}" is in no lane`);
    for (const dep of journey.dependsOn) {
      if (!byId.has(dep)) problems.push(`journey "${journey.id}" depends on unknown "${dep}"`);
    }
    problems.push(...checkBranches(journey));
  }
  script.lanes.forEach((lane, laneIndex) => {
    lane.journeys.forEach((id, position) => {
      const journey = byId.get(id);
      if (journey === undefined) {
        problems.push(`lane "${lane.id}" names unknown journey "${id}"`);
        return;
      }
      for (const dep of journey.dependsOn) {
        if (!byId.has(dep)) continue;
        const sameLane = lane.journeys.slice(0, position).includes(dep);
        const earlierLane = script.lanes
          .slice(0, laneIndex)
          .some((other) => other.journeys.includes(dep));
        if (!sameLane && !earlierLane) {
          problems.push(
            `journey "${id}" in lane "${lane.id}" needs "${dep}", which is neither earlier in its lane nor in an earlier lane`,
          );
        }
      }
    });
  });
  return problems;
}

function checkBranches(journey: Journey): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const step of journey.steps) {
    if (ScriptStepKind.CHECKPOINT === step.kind) seen.add(step.id);
    if (ScriptStepKind.BRANCH === step.kind && !seen.has(step.at)) {
      problems.push(
        `journey "${journey.id}" branches at "${step.at}", which is not a checkpoint before it`,
      );
    }
  }
  return problems;
}

/** The lane barrier a journey waits on: its dependencies that are not earlier in its own lane. */
export function barriersOf(script: DriveScript, laneId: string, journeyId: string): string[] {
  const lane = script.lanes.find((each) => each.id === laneId);
  const journey = script.journeys.find((each) => each.id === journeyId);
  if (lane === undefined || journey === undefined) return [];
  const before = lane.journeys.slice(0, lane.journeys.indexOf(journeyId));
  return journey.dependsOn.filter((dep) => !before.includes(dep));
}

/** One line a person reads for a step: what it drives, in the plan's own words. */
export function stepLabel(step: ScriptStep): string {
  switch (step.kind) {
    case ScriptStepKind.REPLAY:
      return `Replay ${step.flow}${step.at === undefined ? '' : ` from step ${String(step.at)}`}${step.to === undefined ? '' : ` to step ${String(step.to)}`}`;
    case ScriptStepKind.ACT:
      return step.goal ?? `${step.action ?? ''} ${targetText(step.target)}`.trim();
    case ScriptStepKind.ASSERT:
      return `Check ${predicateText(step.predicate)}`;
    case ScriptStepKind.CHECKPOINT:
      return `Checkpoint ${step.id}`;
    case ScriptStepKind.BRANCH:
      return `Branch at ${step.at}: ${step.cases.map((c) => c.label).join(' / ')}`;
  }
}

function targetText(target: Record<string, unknown> | undefined): string {
  if (target === undefined) return '';
  const value = Object.values(target).find((v) => 'string' === typeof v);
  return 'string' === typeof value ? value : '';
}

function predicateText(predicate: unknown): string {
  if ('object' !== typeof predicate || null === predicate) return 'a consequence';
  const record = predicate as Record<string, unknown>;
  const query = record['query'];
  const inner =
    'object' === typeof query && null !== query ? (query as Record<string, unknown>) : {};
  const named =
    record['name'] ??
    record['urlContains'] ??
    record['pathname'] ??
    record['path'] ??
    record['text'] ??
    inner['testid'] ??
    inner['text'];
  const kind = 'string' === typeof record['kind'] ? record['kind'] : 'consequence';
  return 'string' === typeof named ? `${kind} ${named}` : kind;
}
