/**
 * Drive one build through an action plan and read what it shows after each planned sequence.
 *
 * The page is read only after it settles: read, wait, read again, until two reads in a row match,
 * up to `SETTLE_READS` reads. A page that never settles (a slideshow) gives its last read.
 *
 * A sequence that starts another planned sequence is not driven on its own: the longer one is
 * driven, and the page is read after each of its steps. Each planned sequence is read once, in the
 * first run that reaches it, and the order is the same on every build.
 *
 * A step that could not be done (the control is not there, or the action was refused) is recorded
 * for that sequence and each longer one in the run. A driver that lost its browser session throws
 * `DriverLostError`: that says nothing about the build, so the caller makes the whole run invalid.
 */
import {
  longestRuns,
  refFor,
  sequenceKey,
  stepLabel,
  type PlanStep,
  type Sequence,
  type Target,
} from './action-plan.js';
import { visibleLines } from './visible-content.js';

/** A browser tab on one build. */
export interface PageDriver {
  /** Load the start page fresh. False when it did not load. */
  open(): Promise<boolean>;
  /** The whole page as an accessibility tree, with refs and test ids. */
  read(): Promise<string>;
  /** Act on a control by ref. False when the action was refused or did not land. */
  act(ref: string, action: 'click' | 'fill' | 'select', value?: string): Promise<boolean>;
}

/** The driver lost its browser session. The run says nothing about the build. */
export class DriverLostError extends Error {
  override name = 'DriverLostError';
}

/** What one build showed after one planned sequence. */
export interface Reading {
  /** The steps that reach it, as a person reads them, starting with the start page. */
  actions: string[];
  /** The visible lines. Absent when a step could not be done. */
  lines?: string[];
  /** The step that could not be done. */
  failedAt?: string;
}

/** Readings by sequence key. */
export type BuildReadings = Map<string, Reading>;

export const SETTLE_READS = 4;
export const SETTLE_GAP_MS = 400;
/** The first action of every sequence. */
export const START_STEP = 'open the start page';

type Sleep = (ms: number) => Promise<void>;

/** Elapsed times in a page's own log ("0.04s") change between two runs. Keep whole seconds. */
const ELAPSED = /(?<![\w.])(\d+\.\d+)(?:s\b|$)/g;

/** An elapsed time in milliseconds ("3ms", "1400 ms"). */
const ELAPSED_MS = /(?<![\w.])(\d+(?:\.\d+)?) ?ms\b/g;
const MS_PER_S = 1000;

/** What a person sees on the page, one line for each element, with sub-second times rounded. */
export function pageLines(tree: string): string[] {
  return visibleLines(tree).map((line) =>
    line
      .replace(ELAPSED_MS, (_, n: string) => `${String(Math.round(Number(n) / MS_PER_S))}s`)
      .replace(ELAPSED, (_, n: string) => `${String(Math.round(Number(n)))}s`),
  );
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((line, i) => line === b[i]);

/** Read the page once it stops changing. */
export async function settledRead(
  driver: PageDriver,
  sleep: Sleep,
): Promise<{ tree: string; lines: string[] }> {
  let tree = await driver.read();
  let lines = pageLines(tree);
  for (let i = 1; i < SETTLE_READS; i += 1) {
    await sleep(SETTLE_GAP_MS);
    const nextTree = await driver.read();
    const next = pageLines(nextTree);
    tree = nextTree;
    const settled = same(next, lines);
    lines = next;
    if (settled) {
      break;
    }
  }
  return { tree, lines };
}

/** The ref of `target`, reading again while the page is still settling. */
async function locate(
  driver: PageDriver,
  tree: string,
  target: Target,
  sleep: Sleep,
): Promise<{ ref?: string; tree: string }> {
  let now = tree;
  for (let i = 1; i < SETTLE_READS; i += 1) {
    const ref = refFor(now, target);
    if (ref !== undefined) {
      return { ref, tree: now };
    }
    await sleep(SETTLE_GAP_MS);
    now = await driver.read();
  }
  const ref = refFor(now, target);
  return ref === undefined ? { tree: now } : { ref, tree: now };
}

/** Do one step on the page `tree` shows. False when it could not be done. */
async function perform(
  driver: PageDriver,
  step: PlanStep,
  tree: string,
  sleep: Sleep,
): Promise<boolean> {
  if ('wait' === step.action) {
    await sleep(step.ms);
    return true;
  }
  const acts =
    'fillall' === step.action
      ? step.fields.map((f) => ({ action: 'fill' as const, target: f.target, value: f.value }))
      : [step];
  let now = tree;
  for (const act of acts) {
    const found = await locate(driver, now, act.target, sleep);
    now = found.tree;
    if (found.ref === undefined) {
      return false;
    }
    const value = 'click' === act.action ? undefined : act.value;
    if (!(await driver.act(found.ref, act.action, value))) {
      return false;
    }
  }
  return true;
}

/**
 * Drive one sequence from a fresh load, for the plan. The settled tree after its last step, or
 * undefined when a step could not be done.
 */
export async function probeSequence(
  driver: PageDriver,
  seq: Sequence,
  sleep: Sleep,
): Promise<string | undefined> {
  if (!(await driver.open())) {
    return undefined;
  }
  let tree = await driver.read();
  for (const [i, step] of seq.entries()) {
    if (!(await perform(driver, step, tree, sleep))) {
      return undefined;
    }
    // The last step is followed by the settled read.
    if (i < seq.length - 1) {
      tree = await driver.read();
    }
  }
  return (await settledRead(driver, sleep)).tree;
}

const labelsOf = (seq: Sequence): string[] => [START_STEP, ...seq.map(stepLabel)];

/** Drive the plan on one build. */
export async function readBuild(
  driver: PageDriver,
  plan: readonly Sequence[],
  sleep: Sleep,
): Promise<BuildReadings> {
  const planned = new Set(plan.map(sequenceKey));
  const out: BuildReadings = new Map();
  const isNew = (seq: Sequence): boolean => {
    const key = sequenceKey(seq);
    return planned.has(key) && !out.has(key);
  };
  /** Read after `seq`: settled and recorded the first time, else one read for the refs. */
  const take = async (seq: Sequence): Promise<string> => {
    if (!isNew(seq)) {
      return driver.read();
    }
    const read = await settledRead(driver, sleep);
    out.set(sequenceKey(seq), { actions: labelsOf(seq), lines: read.lines });
    return read.tree;
  };
  const failFrom = (run: Sequence, from: number, failedAt: string): void => {
    for (let n = from; n <= run.length; n += 1) {
      const seq = run.slice(0, n);
      if (isNew(seq)) {
        out.set(sequenceKey(seq), { actions: labelsOf(seq), failedAt });
      }
    }
  };
  for (const run of longestRuns(plan)) {
    if (!(await driver.open())) {
      failFrom(run, 0, START_STEP);
      continue;
    }
    let tree = await take([]);
    for (const [i, step] of run.entries()) {
      if (!(await perform(driver, step, tree, sleep))) {
        failFrom(run, i + 1, stepLabel(step));
        break;
      }
      tree = await take(run.slice(0, i + 1));
    }
  }
  return out;
}
