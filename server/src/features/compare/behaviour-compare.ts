/**
 * `reticle compare`: drive two running builds of one app the same way, and report each difference
 * in what a person sees. The recipe has no settings:
 *
 * 1. Read the values the reference's scripts compare fields with (`value-dictionary.ts`), then make
 *    the action plan on the reference (`action-plan.ts`).
 * 2. Drive the plan on the reference, the candidate, the base when given, and the reference again,
 *    in that order, each in a new browser tab (`build-readings.ts`). The two reference runs are on
 *    each side of the candidate, so a line that changes with time is seen as noise.
 * 3. Compare (`behaviour-diff.ts`).
 *
 * A lost browser session makes the run invalid, never a difference.
 */
import { NOTHING_DROPPED, buildPlan, sequenceKey, type Plan } from './action-plan.js';
import { harvestDictionary } from './outside/value-dictionary.js';
import { compareBehaviour, invalidComparison, type BehaviourComparison } from './behaviour-diff.js';
import type { CompareTimings } from './behaviour-report.js';
import {
  DriverLostError,
  probeSequence,
  readBuild,
  settledRead,
  type BuildReadings,
  type PageDriver,
} from './build-readings.js';

/** A new browser tab on one build. */
export interface OpenedPage extends PageDriver {
  close(): Promise<void>;
}

export interface CompareInput {
  reference: string;
  candidate: string;
  base?: string;
  /** Open a new tab on `url`. Throws when the tab cannot be opened. */
  open(url: string): Promise<OpenedPage>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Fetch a file the way a browser does. Undefined when it could not be fetched. */
  fetchText: (url: string) => Promise<string | undefined>;
}

const MS_PER_TENTH = 100;
const TENTHS = 10;
const LOST_SESSION = 'The browser session was lost, so this run proves nothing. Run it again:';

async function withPage<T>(
  input: CompareInput,
  url: string,
  use: (page: OpenedPage) => Promise<T>,
): Promise<T> {
  const page = await input.open(url);
  try {
    return await use(page);
  } finally {
    await page.close();
  }
}

/** Make the plan on the reference. A start page that does not load gives the start page only. */
async function planOn(input: CompareInput, page: OpenedPage): Promise<Plan> {
  if (!(await page.open())) {
    return { sequences: [[]], dropped: NOTHING_DROPPED };
  }
  const dictionary = await harvestDictionary(input.reference, input.fetchText);
  const start = (await settledRead(page, input.sleep)).tree;
  return buildPlan(start, (seq) => probeSequence(page, seq, input.sleep), dictionary);
}

export async function runCompare(
  input: CompareInput,
): Promise<{ result: BehaviourComparison; timings?: CompareTimings }> {
  const timed = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
    const start = input.now();
    const value = await work();
    return [value, Math.round((input.now() - start) / MS_PER_TENTH) / TENTHS];
  };
  let sequences = 0;
  try {
    const [{ sequences: plan, dropped }, planS] = await timed(() =>
      withPage(input, input.reference, (page) => planOn(input, page)),
    );
    sequences = plan.length;
    const drive = (url: string): Promise<[BuildReadings, number]> =>
      timed(() => withPage(input, url, (page) => readBuild(page, plan, input.sleep)));
    const [reference, referenceS] = await drive(input.reference);
    const [candidate, candidateS] = await drive(input.candidate);
    const based = input.base === undefined ? undefined : await drive(input.base);
    const [again, againS] = await drive(input.reference);
    const result = compareBehaviour({
      order: plan.map(sequenceKey),
      reference,
      again,
      candidate,
      ...(based === undefined ? {} : { base: based[0] }),
    });
    const timings: CompareTimings = {
      plan: planS,
      reference: referenceS,
      candidate: candidateS,
      ...(based === undefined ? {} : { base: based[1] }),
      again: againS,
    };
    return { result: { ...result, planDropped: dropped }, timings };
  } catch (error) {
    if (error instanceof DriverLostError) {
      return { result: invalidComparison(`${LOST_SESSION} ${error.message}`, sequences) };
    }
    throw error;
  }
}
