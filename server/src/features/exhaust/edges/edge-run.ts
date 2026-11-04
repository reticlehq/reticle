/**
 * One edge sequence, driven, and what its run shows without a reference answer.
 *
 * `runEdge` replays a state from a fresh start page, runs the steps, and reads what the checks in
 * `invariants.ts` compare: the page before the steps, the page at each settle, the page at the end,
 * and the writes of each stretch between settles. Two steps with no settle between them run back
 * to back, which is how a double click reaches the app before the first click's request comes back.
 *
 * `faultsOf` and `shownVsSent` judge any run. A fault the plain click of the same control already
 * showed is the explorer's finding, not an edge case's, so the caller passes it in `known`.
 */

import { REDACTED_VALUE, asNumber, asString, type ReticleEvent } from '@reticlehq/core';
import { EdgeAction, describeStep, type EdgeStep } from '../edge-cases.js';
import {
  controlsOf,
  noteAnomalies,
  replayPath,
  type ActResult,
  type ExplorePort,
  type ExploreReport,
  type PageRead,
  type Step,
} from '../explorer.js';
import {
  Invariant,
  checkShownMatchesSent,
  type PageObservation,
  type WriteObservation,
} from '../invariants.js';
import type { BehaviourFinding } from '../ledger.js';
import { controlKey, writeKeyOf } from '../session-fold.js';

/** A server error is a fault whatever the input was. A 4xx is the server refusing bad input. */
const SERVER_FAULT = 500;
const VALUE_ATTR = /\[value="((?:[^"\\]|\\.)*)"/;
/** Letters and digits only, lower case: `First name` and `firstName` are one name. */
const bare = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export interface EdgeRun {
  /** The page after the state was replayed, before the first step. */
  before: PageObservation;
  /** The page at each settle step, in order. */
  marks: PageObservation[];
  /** The page after the last step. */
  after: PageObservation;
  /** The writes of each stretch between settle steps. */
  writes: WriteObservation[][];
  /** Every event the steps caused. */
  events: ReticleEvent[];
  /** The source of the first control the run acted on, when the app gives it. */
  source?: { file: string; line: number };
}

/** The port, with the budget the caller counts. */
export interface EdgeDriver {
  port: ExplorePort;
  act: (
    ref: string,
    action: 'click' | 'fill',
    value?: string,
    opts?: { settle?: boolean },
  ) => Promise<ActResult>;
  /** Back or reload, counted as one action. */
  move: (action: typeof EdgeAction.BACK | typeof EdgeAction.RELOAD) => Promise<boolean>;
  spent: () => boolean;
  wait?: () => Promise<void>;
}

const writesOf = (events: readonly ReticleEvent[]): WriteObservation[] =>
  events.flatMap((e) => {
    const key = writeKeyOf(e);
    if (key === undefined) {
      return [];
    }
    const status = asNumber(e.data['status']);
    const response = asString(e.data['responseBody']);
    return [
      {
        key,
        ...(status === undefined ? {} : { status }),
        ...(response === undefined ? {} : { response }),
      },
    ];
  });

/** Replay `path`, then run `steps`. Undefined when the state or a step's control was not there. */
export async function runEdge(
  d: EdgeDriver,
  path: readonly Step[],
  steps: readonly EdgeStep[],
): Promise<EdgeRun | undefined> {
  if (!(await replayPath(d.port, path, d.act, d.spent))) {
    return undefined;
  }
  const read = (): Promise<PageRead> => (d.port.lookFull ?? d.port.look)();
  const before = await read();
  let controls = controlsOf((await d.port.look()).tree);
  const marks: PageObservation[] = [];
  const stretches: ReticleEvent[][] = [[]];
  let source: EdgeRun['source'];
  for (const [index, step] of steps.entries()) {
    if (d.spent()) {
      return undefined;
    }
    if ('key' in step) {
      const control = controls.find((c) => c.key === step.key);
      if (control === undefined) {
        return undefined;
      }
      const next = steps[index + 1];
      const settle = next === undefined || EdgeAction.SETTLE === next.action;
      const result = await d.act(control.ref, step.action, step.value, { settle });
      source ??= result.source;
      stretches.at(-1)?.push(...result.events);
    } else if (EdgeAction.SETTLE === step.action) {
      await d.wait?.();
      marks.push(await read());
      controls = controlsOf((await d.port.look()).tree);
      stretches.push([]);
    } else {
      if (!(await d.move(step.action))) {
        return undefined;
      }
      controls = controlsOf((await d.port.look()).tree);
    }
  }
  await d.wait?.();
  const after = await read();
  return {
    before,
    marks,
    after,
    writes: stretches.map(writesOf),
    events: stretches.flat(),
    ...(source === undefined ? {} : { source }),
  };
}

const findingFrom = (
  kind: string,
  detail: string,
  steps: readonly EdgeStep[],
  source: EdgeRun['source'],
): BehaviourFinding => ({
  kind,
  invariant: Invariant.NO_FAULT,
  detail,
  sequence: steps.map(describeStep),
  ...(source === undefined ? {} : { source: `${source.file}:${String(source.line)}` }),
});

/**
 * The faults the run's events show: page errors, server errors and contradictions. A fault already
 * in `known` (as `control\nkind`) is skipped, and each new one is added, so it is reported once.
 */
export function faultsOf(
  run: EdgeRun,
  control: string,
  steps: readonly EdgeStep[],
  known: Set<string>,
): BehaviourFinding[] {
  const anomalies: ExploreReport['anomalies'] = [];
  noteAnomalies(run.events, control, anomalies, SERVER_FAULT);
  const out: BehaviourFinding[] = [];
  for (const a of anomalies) {
    const id = `${control}\n${a.kind}`;
    if (!known.has(id)) {
      known.add(id);
      out.push(findingFrom(a.kind, a.detail, steps, run.source));
    }
  }
  return out;
}

/** The value a field shows on a page, when the field is there and shows one. */
export function shownValue(page: PageObservation, field: string): string | undefined {
  for (const line of page.tree.split('\n')) {
    if (controlKey(line) === field) {
      return VALUE_ATTR.exec(line)?.[1];
    }
  }
  return undefined;
}

/** The top-level values of a JSON object body, by bare name. Empty for any other body. */
function bodyValues(event: ReticleEvent): Map<string, string> {
  const out = new Map<string, string>();
  const text = asString(event.data['requestBody']);
  if (text === undefined) {
    return out;
  }
  try {
    const body: unknown = JSON.parse(text);
    if ('object' !== typeof body || null === body || Array.isArray(body)) {
      return out;
    }
    for (const [key, value] of Object.entries(body)) {
      if ('string' === typeof value || 'number' === typeof value) {
        out.set(bare(key), String(value));
      }
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * For each field the steps filled: when a write sent a value under the field's name, the field
 * must show that value after the write. Matched by name only.
 * ponytail: top-level JSON keys only; a nested or form-encoded body is not read.
 */
export function shownVsSent(run: EdgeRun, steps: readonly EdgeStep[]): BehaviourFinding[] {
  const sent = run.events.filter((e) => writeKeyOf(e) !== undefined).map(bodyValues);
  const out: BehaviourFinding[] = [];
  for (const step of steps) {
    if (!('key' in step) || EdgeAction.FILL !== step.action) {
      continue;
    }
    const name = bare(/"([^"]*)"/.exec(step.key)?.[1] ?? '');
    const value = sent.map((body) => body.get(name)).find((v) => v !== undefined);
    if (0 === name.length || value === undefined || REDACTED_VALUE === value) {
      continue;
    }
    out.push(
      ...checkShownMatchesSent({
        field: step.key,
        sent: value,
        shown: shownValue(run.after, step.key),
        steps,
        ...(run.source === undefined ? {} : { source: run.source }),
      }),
    );
  }
  return out;
}
