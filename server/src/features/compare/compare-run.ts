/**
 * Drive two builds of one app with the same actions, and read what each one shows after every step.
 *
 * The actions come from two places. The project's saved flows are replayed one step at a time, and
 * the page is read after each step, not only where the flow has a check. The explorer the exhaustive
 * crawl uses (`explore`) walks the reference's states breadth first, and every click it tried
 * becomes a journey. Only the reference is explored: both builds then get the same list of journeys,
 * so a control the candidate lost shows as a step it could not do.
 *
 * Four browsers, one after the other: one to explore, two runs of the reference (the second sets
 * what is noise), and one run of the candidate. Each run starts in a new browser, so state one run
 * leaves (a cookie, local storage) cannot reach the next one.
 */
import { controlsOf, explore, type ExplorePort, type Step } from '@/features/exhaust/explorer.js';
import { compareReadings, type Comparison, type StepReading } from './compare-diff.js';
import { visibleLines } from './visible-content.js';

/** A browser on one build: what the explorer needs, plus a full read and one step of a saved flow. */
export interface CompareDriver extends ExplorePort {
  /** The whole page as an accessibility tree. */
  read(): Promise<string>;
  /**
   * Do step `index` of the saved flow `flow`. Step 0 opens the flow's start page first. Every later
   * step continues on the page as the step before it left it. `label` says what the step did.
   */
  replayStep(flow: string, index: number): Promise<{ done: boolean; label: string }>;
  close(): Promise<void>;
}

export interface CompareInput {
  reference: string;
  candidate: string;
  /** Open a new browser on a build. Throws when the build cannot be opened. */
  open(url: string): Promise<CompareDriver>;
  /** The saved flows to replay, and how many steps each has. */
  flows: readonly { name: string; steps: number }[];
  /** The explorer's action budget. */
  maxActions: number;
  /** Called after each action, before the page is read, so behaviour driven by a timer can show. */
  wait: () => Promise<void>;
}

export interface CompareResult extends Comparison {
  /** How many journeys each build was driven through. */
  journeys: number;
  /** What the explorer found on the reference. A non-zero frontier means it stopped at its budget. */
  explored: { states: number; actions: number; frontier: number; budgetExhausted: boolean };
}

type Journey =
  | { kind: typeof JourneyKind.FLOW; name: string; steps: number }
  | { kind: typeof JourneyKind.PATH; steps: readonly Step[] };

const JourneyKind = { FLOW: 'flow', PATH: 'path' } as const;
const StepAction = { CLICK: 'click', FILL: 'fill' } as const;

/** The action that reaches the start page, for the journey that only reads it. */
export const START_ACTION = 'open the start page';
/** What the explorer types into a text field: this, then the field's position on its state. */
export const FILL_TEXT = 'text';

const flowStepLabel = (flow: string, index: number, label: string): string =>
  `flow "${flow}" step ${String(index + 1)}: ${label}`;

const pathStepLabel = (step: Step): string =>
  StepAction.FILL === step.action
    ? `${StepAction.FILL} ${step.key} with "${step.value ?? ''}"`
    : `${StepAction.CLICK} ${step.key}`;

/** The paths that are not the start of a longer path: reading a long path reads its starts too. */
function longestPaths(paths: readonly Step[][]): Step[][] {
  const text = paths.map((path) => path.map((step) => JSON.stringify(step)));
  return paths.filter((path, i) =>
    text.every(
      (other, j) =>
        i === j || other.length <= path.length || path.some((_, k) => other[k] !== text[i]?.[k]),
    ),
  );
}

async function readLines(driver: CompareDriver, wait: () => Promise<void>): Promise<string[]> {
  await wait();
  return visibleLines(await driver.read());
}

async function readFlow(
  driver: CompareDriver,
  journey: number,
  flow: { name: string; steps: number },
  wait: () => Promise<void>,
): Promise<StepReading[]> {
  const out: StepReading[] = [];
  const actions: string[] = [];
  for (let step = 0; step < flow.steps; step += 1) {
    const done = await driver.replayStep(flow.name, step);
    actions.push(flowStepLabel(flow.name, step, done.label));
    if (!done.done) {
      out.push({ journey, step, actions: [...actions] });
      break;
    }
    out.push({ journey, step, actions: [...actions], lines: await readLines(driver, wait) });
  }
  return out;
}

async function readPath(
  driver: CompareDriver,
  journey: number,
  steps: readonly Step[],
  wait: () => Promise<void>,
): Promise<StepReading[]> {
  if (!(await driver.reset())) {
    return [{ journey, step: 0, actions: [START_ACTION] }];
  }
  if (0 === steps.length) {
    return [{ journey, step: 0, actions: [START_ACTION], lines: await readLines(driver, wait) }];
  }
  const out: StepReading[] = [];
  const actions: string[] = [];
  for (const [index, step] of steps.entries()) {
    actions.push(pathStepLabel(step));
    // The first control with this identity, on every build, so both builds act on the same one.
    const control = controlsOf((await driver.look()).tree).find((c) => c.key === step.key);
    const done =
      control !== undefined && (await driver.act(control.ref, step.action, step.value)).ok;
    if (!done) {
      out.push({ journey, step: index, actions: [...actions] });
      break;
    }
    out.push({ journey, step: index, actions: [...actions], lines: await readLines(driver, wait) });
  }
  return out;
}

/** Drive one build through every journey, in a new browser, and read it after every step. */
async function readBuild(
  input: CompareInput,
  url: string,
  journeys: readonly Journey[],
): Promise<StepReading[]> {
  const driver = await input.open(url);
  try {
    const out: StepReading[] = [];
    for (const [index, journey] of journeys.entries()) {
      if (JourneyKind.FLOW === journey.kind) {
        out.push(...(await readFlow(driver, index, journey, input.wait)));
      } else {
        out.push(...(await readPath(driver, index, journey.steps, input.wait)));
      }
    }
    return out;
  } finally {
    await driver.close();
  }
}

export async function compareBuilds(input: CompareInput): Promise<CompareResult> {
  const explorer = await input.open(input.reference);
  let report: Awaited<ReturnType<typeof explore>>;
  try {
    report = await explore(explorer, {
      maxActions: input.maxActions,
      // Each field its own value, so a build that swaps two fields does not read the same.
      fillValue: (_label, index) => `${FILL_TEXT} ${String(index + 1)}`,
      wait: input.wait,
    });
  } finally {
    await explorer.close();
  }
  const journeys: Journey[] = [
    ...input.flows.map((flow) => ({ kind: JourneyKind.FLOW, ...flow })),
    { kind: JourneyKind.PATH, steps: [] },
    ...longestPaths(report.paths).map((steps) => ({ kind: JourneyKind.PATH, steps })),
  ];
  const reference = await readBuild(input, input.reference, journeys);
  const again = await readBuild(input, input.reference, journeys);
  const candidate = await readBuild(input, input.candidate, journeys);
  return {
    ...compareReadings(reference, again, candidate),
    journeys: journeys.length,
    explored: {
      states: report.states,
      actions: report.actions,
      frontier: report.frontier,
      budgetExhausted: report.budgetExhausted,
    },
  };
}
