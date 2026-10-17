/**
 * Whether a saved flow can replay at all, decided when it is saved, and what save changes so it can.
 *
 * Of 34 flows saved over one night, 5 replayed green. None of the misses was a defect in the app:
 * a flow with no starting page, an anchor six buttons share, a live count ("Open 336") the next run
 * cannot see again, or a step that WROTE real data each time it replayed. Each was found by a
 * replay that drifted, never said when the flow was saved. This says it at save, and again with
 * every suite verdict.
 *
 * Pure: a flow in, a flow or a report out. No IO, no clock.
 */
import { z } from 'zod';
import {
  AnchorKind,
  DEGRADED_ANCHOR_ROLE,
  MUTATING_METHODS,
  PredicateKind,
  type FlowFile,
  type FlowStep,
  type Predicate,
} from '@reticlehq/core';

export const Replayable = {
  YES: 'replayable',
  NO: 'not_replayable',
  /** It replays, but an expect names data the next run will not see again. */
  DATA_BOUND: 'data_bound',
} as const;
export type Replayable = (typeof Replayable)[keyof typeof Replayable];

export interface Replayability {
  status: Replayable;
  /** One sentence for each reason, by step. Absent when there is nothing to say. */
  why?: string[];
  /** A step sends a write request, so a replay changes real data. */
  writes?: true;
}

const NUMBER = /\d[\d,.]*/g;
const HAS_NUMBER = /\d/;
/** The words of a money check. Its number IS the claim, so it is never made word-level. */
const MONEY = /credit|price|cost|charge|balance|paid|pay|invoice|refund|\$|€|£/i;
/** A fragment kept as the words of a count: at least two letters. */
const WORDS = /[A-Za-z]{2,}/;
const NUMBER_PATTERN = '\\d[\\d,.]*';
const MATCHES_PATTERN = 'matchesPattern';

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A text expect with a live count, made word-level: the words stay exact, the number may change.
 * Undefined when it cannot be: no words beside the number, a money check, or a `satisfies` already.
 */
function wordLevel(contains: string, money: boolean): Predicate | undefined {
  if (money || MONEY.test(contains)) return undefined;
  const words = contains
    .split(NUMBER)
    .map((part) => part.trim())
    .filter((part) => WORDS.test(part))
    .sort((a, b) => b.length - a.length)[0];
  if (words === undefined) return undefined;
  const pattern = contains.split(NUMBER).map(escapeRegex).join(NUMBER_PATTERN);
  return {
    kind: PredicateKind.TEXT,
    contains: words,
    satisfies: { property: MATCHES_PATTERN, pattern },
  };
}

function relax(predicate: Predicate, money: boolean): Predicate {
  if (PredicateKind.ALL_OF === predicate.kind || PredicateKind.ANY_OF === predicate.kind) {
    return { ...predicate, predicates: predicate.predicates.map((p) => relax(p, money)) };
  }
  if (
    PredicateKind.TEXT === predicate.kind &&
    predicate.satisfies === undefined &&
    predicate.contains !== undefined &&
    HAS_NUMBER.test(predicate.contains)
  ) {
    const relaxed = wordLevel(predicate.contains, money);
    if (relaxed !== undefined) {
      const { contains: _contains, ...rest } = predicate;
      return { ...rest, ...relaxed };
    }
  }
  return predicate;
}

/** Every leaf predicate under a composite, `not` included: a count is data-bound either way. */
function leaves(predicate: Predicate | undefined): Predicate[] {
  if (predicate === undefined) return [];
  if (PredicateKind.ALL_OF === predicate.kind || PredicateKind.ANY_OF === predicate.kind) {
    return predicate.predicates.flatMap(leaves);
  }
  if (PredicateKind.NOT === predicate.kind) return leaves(predicate.predicate);
  return [predicate];
}

/** The write requests an expect names, as "METHOD url". */
function writesNamed(predicate: Predicate | undefined): string[] {
  return leaves(predicate).flatMap((leaf) =>
    PredicateKind.NET === leaf.kind &&
    leaf.method !== undefined &&
    MUTATING_METHODS.includes(leaf.method.toUpperCase())
      ? [`${leaf.method.toUpperCase()} ${leaf.urlContains ?? ''}`.trim()]
      : [],
  );
}

/** The live data an expect names: a number in text, in an element's name or text, or in state. */
function liveData(predicate: Predicate | undefined): string[] {
  return leaves(predicate).flatMap((leaf): string[] => {
    if (PredicateKind.TEXT === leaf.kind && leaf.satisfies === undefined) {
      return leaf.contains !== undefined && HAS_NUMBER.test(leaf.contains) ? [leaf.contains] : [];
    }
    if (PredicateKind.ELEMENT === leaf.kind) {
      return [leaf.query.name, leaf.query.text].filter(
        (value): value is string => value !== undefined && HAS_NUMBER.test(value),
      );
    }
    if (PredicateKind.STATE === leaf.kind && 'number' === typeof leaf.equals) {
      return [`${leaf.path} = ${String(leaf.equals)}`];
    }
    return [];
  });
}

function readyStep(step: FlowStep, money: boolean): FlowStep {
  const steps = step.steps?.map((sub) => readyStep(sub, money));
  const expect = step.expect === undefined ? undefined : relax(step.expect, money);
  const writes =
    true === step.writes ||
    0 < writesNamed(step.expect).length ||
    true === steps?.some((sub) => true === sub.writes);
  return {
    ...step,
    ...(expect === undefined ? {} : { expect }),
    ...(steps === undefined ? {} : { steps }),
    ...(writes ? { writes: true } : {}),
  };
}

/**
 * The flow as it is saved: a live count in a text expect becomes word-level where the step allows
 * it, and a step whose expect names a write request is marked `writes`. A money check keeps its
 * number exact, and the report then says the flow is bound to the data.
 */
export function readyForReplay(flow: FlowFile): FlowFile {
  const money = MONEY.test(flow.intent ?? '');
  return { ...flow, steps: flow.steps.map((step) => readyStep(step, money)) };
}

interface Addressed {
  at: string;
  step: FlowStep;
}

function addressed(steps: readonly FlowStep[], prefix = ''): Addressed[] {
  return steps.flatMap((step, i) => {
    const at = `${prefix}${String(i + 1)}`;
    return [{ at, step }, ...addressed(step.steps ?? [], `${at}.`)];
  });
}

/** Whether the flow can replay, and why not, by step. */
export function replayability(flow: FlowFile): Replayability {
  const blocked: string[] = [];
  const bound: string[] = [];
  const writes: string[] = [];
  if (flow.startPath === undefined || '' === flow.startPath) {
    blocked.push('no starting page was recorded, so a replay starts wherever the tab is');
  }
  for (const { at, step } of addressed(flow.steps)) {
    // A hand-written flow read without the schema can lack an anchor; it then says nothing here.
    const anchor: FlowStep['anchor'] | undefined = (step as Partial<FlowStep>).anchor;
    // A sequence's own anchor is a copy of a sub-step's; the sub-step answers for it.
    const own = step.steps === undefined;
    if (
      own &&
      (true === step.degraded ||
        (AnchorKind.ROLE === anchor?.kind && DEGRADED_ANCHOR_ROLE === anchor.role))
    ) {
      blocked.push(`step ${at} has no anchor a replay can find`);
    } else if (own && AnchorKind.TESTID === anchor?.kind && anchor.of !== undefined) {
      blocked.push(
        `step ${at} anchors on test id '${anchor.value}', which ${String(anchor.of)} elements share`,
      );
    }
    if (
      own &&
      AnchorKind.ROLE === anchor?.kind &&
      anchor.name !== undefined &&
      HAS_NUMBER.test(anchor.name)
    ) {
      bound.push(`step ${at} acts on a control named '${anchor.name}', a live count`);
    }
    for (const data of liveData(step.expect)) bound.push(`step ${at} expects '${data}', live data`);
    for (const write of own ? writesNamed(step.expect) : [])
      writes.push(`step ${at} sends ${write}`);
    if (own && true === step.writes && 0 === writesNamed(step.expect).length) {
      writes.push(`step ${at} sent a write request when it was recorded`);
    }
  }
  const why = [...blocked, ...bound, ...writes];
  const status =
    0 < blocked.length ? Replayable.NO : 0 < bound.length ? Replayable.DATA_BOUND : Replayable.YES;
  return {
    status,
    ...(0 === why.length ? {} : { why }),
    ...(0 === writes.length ? {} : { writes: true }),
  };
}

/** The suite's argument and field for this, worded once. */
export const SKIP_WRITES_ARG = z
  .boolean()
  .optional()
  .describe(
    'Certify without changing data: hold back every flow with a step that sends a write request (POST, PUT, PATCH, DELETE), and name them in `skippedWrites`.',
  );
export const REPLAYABILITY_OUTPUT = z
  .array(z.unknown())
  .optional()
  .describe(
    'Each flow that cannot replay as saved: not_replayable (no starting page, an anchor no replay can find or several elements share) or data_bound (live data in an expect), and writes when a step sends a write request. A drift on such a flow is the flow, not the app.',
  );
