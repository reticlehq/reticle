/**
 * A session's journal as the App Graph's driven steps (`@reticlehq/core`'s `mapOfRun`): what each act
 * pressed, anchored the way a flow anchors it, the events of its own window, and whether what it
 * declared held. The cloud reads the same steps off its harness's calls; a coding agent's acts are
 * read off the journal the daemon already keeps, so building the graph costs the act path nothing.
 */
import {
  ReticleTool,
  asString,
  type DrivenStep,
  type JournalAction,
  type ReticleEvent,
} from '@reticlehq/core';

/** The acts that press something. Reads, waits and navigation press nothing. */
const PRESSING: ReadonlySet<string> = new Set([
  ReticleTool.ACT,
  ReticleTool.ACT_AND_WAIT,
  ReticleTool.ACT_SEQUENCE,
]);

const record = (value: unknown): Record<string, unknown> =>
  'object' === typeof value && null !== value ? (value as Record<string, unknown>) : {};

/** A step's target as a flow's anchor; undefined for a ref, which no later run can find again. */
const anchorOf = (step: Record<string, unknown>): Record<string, unknown> | undefined => {
  const target = record(step['target']);
  const testid =
    asString(target['testid']) ?? ('testid' === step['by'] ? asString(step['value']) : undefined);
  if (testid !== undefined) {
    return { by: 'testid', value: testid };
  }
  const role =
    asString(target['role']) ?? ('role' === step['by'] ? asString(step['value']) : undefined);
  const name = asString(target['name']) ?? asString(step['name']);
  return role !== undefined && name !== undefined ? { by: 'role', value: role, name } : undefined;
};

const heldOf = (effect: unknown): boolean | undefined => {
  const verified = record(effect)['verified'];
  if ('yes' === verified) {
    return true;
  }
  if ('no' === verified) {
    return false;
  }
  return undefined;
};

export function journalSteps(
  actions: readonly JournalAction[],
  events: readonly ReticleEvent[],
): DrivenStep[] {
  const steps: DrivenStep[] = [];
  const within = (from: number, to: number): ReticleEvent[] =>
    events.filter((e) => e.t >= from && e.t <= to);
  // The steps of the last sequence, by index, so its later verdict lines find them.
  let sequence: DrivenStep[] = [];
  for (const a of actions) {
    if (!PRESSING.has(a.tool)) {
      continue;
    }
    const args = record(a.args);
    const index = args['step'];
    // A sequence's verdict for one of its steps arrives as its own line.
    if ('number' === typeof index) {
      const step = sequence[index];
      const held = heldOf(a.effect);
      if (step !== undefined && held !== undefined) {
        step.held = held;
      }
      continue;
    }
    const inner = Array.isArray(args['steps']) ? args['steps'].map(record) : undefined;
    if (inner === undefined) {
      const anchor = anchorOf(args);
      if (anchor === undefined) {
        continue;
      }
      const held = heldOf(a.effect);
      steps.push({
        anchor,
        since: a.tRange.from,
        window: within(a.tRange.from, a.tRange.to),
        ...(held === undefined ? {} : { held }),
      });
      continue;
    }
    // ponytail: one window for the whole sequence, credited to its last step; per-step windows
    // would need the journal to record each step's range.
    sequence = [];
    inner.forEach((step, i) => {
      const anchor = anchorOf(step);
      const last = i === inner.length - 1;
      const driven: DrivenStep | undefined =
        anchor === undefined
          ? undefined
          : {
              anchor,
              since: a.tRange.from,
              window: last ? within(a.tRange.from, a.tRange.to) : [],
            };
      if (driven !== undefined) {
        steps.push(driven);
      }
      // Kept by position, so a step without an anchor still takes its index.
      sequence[i] = driven ?? { anchor: {}, since: a.tRange.from, window: [] };
    });
  }
  return steps;
}
