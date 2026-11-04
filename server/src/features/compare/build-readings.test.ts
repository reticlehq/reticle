import { describe, expect, it } from 'vitest';
import { sequenceKey, type PlanStep, type Sequence } from './action-plan.js';
import {
  DriverLostError,
  SETTLE_READS,
  START_STEP,
  pageLines,
  probeSequence,
  readBuild,
  settledRead,
  type PageDriver,
} from './build-readings.js';

const noSleep = (): Promise<void> => Promise.resolve();

/** A page with one counter button: each click adds one. `refuse` names refs whose act fails. */
function counterPage(opts: { refuse?: string; trees?: string[] } = {}): PageDriver & {
  reads: number;
  opens: number;
  acts: string[];
} {
  let count = 0;
  const page = {
    reads: 0,
    opens: 0,
    acts: [] as string[],
    open: () => {
      page.opens += 1;
      count = 0;
      return Promise.resolve(true);
    },
    read: () => {
      page.reads += 1;
      const scripted = opts.trees?.shift();
      return Promise.resolve(
        scripted ??
          `- button "Add" (ref=e1)\n- status "Count" [text="${String(count)}"]\n- button "Other" (ref=e2)`,
      );
    },
    act: (ref: string, action: string) => {
      page.acts.push(`${action} ${ref}`);
      if (ref === opts.refuse) {
        return Promise.resolve(false);
      }
      count += 1;
      return Promise.resolve(true);
    },
  };
  return page;
}

const add: PlanStep = { action: 'click', target: { role: 'button', name: 'Add', nth: 0 } };
const other: PlanStep = { action: 'click', target: { role: 'button', name: 'Other', nth: 0 } };

describe('pageLines', () => {
  it('rounds an elapsed time in milliseconds to whole seconds too', () => {
    expect(pageLines('- text "3ms"\n- text "Took 1400 ms"')).toEqual(['0s', 'took 1s']);
  });

  it('keeps what a person sees and rounds sub-second elapsed times to whole seconds', () => {
    expect(pageLines('- status "Done" [text="Took 0.42s"] (ref=e1)')).toEqual(['done took 0s']);
  });
});

describe('settledRead', () => {
  it('stops when two reads in a row match', async () => {
    const page = counterPage();
    await settledRead(page, noSleep);
    expect(page.reads).toBe(2);
  });

  it('gives up after a fixed number of reads on a page that never settles', async () => {
    const page = counterPage({ trees: ['- text "1"', '- text "2"', '- text "3"', '- text "4"'] });
    const read = await settledRead(page, noSleep);
    expect(page.reads).toBe(SETTLE_READS);
    expect(read.lines).toEqual(['4']);
  });
});

describe('readBuild', () => {
  it('reads every planned sequence once, from the runs that are not a start of another', async () => {
    const page = counterPage();
    const plan: Sequence[] = [[], [add], [add, add], [other]];
    const readings = await readBuild(page, plan, noSleep);
    expect([...readings.keys()].sort()).toEqual(plan.map(sequenceKey).sort());
    expect(readings.get(sequenceKey([add, add]))?.lines).toContain('count 2');
    expect(readings.get(sequenceKey([add]))?.actions).toEqual([START_STEP, 'click button "Add"']);
    // Two runs ([add, add] and [other]), not four.
    expect(page.opens).toBe(2);
  });

  it('records a step that could not be done for that sequence and every longer one', async () => {
    const page = counterPage({ refuse: 'e1' });
    const readings = await readBuild(page, [[], [add], [add, add]], noSleep);
    expect(readings.get(sequenceKey([add]))?.failedAt).toBe('click button "Add"');
    expect(readings.get(sequenceKey([add, add]))?.failedAt).toBe('click button "Add"');
    expect(readings.get(sequenceKey([]))?.lines).toContain('count 0');
  });

  it('counts a control that is not on the page as a step that could not be done', async () => {
    const page = counterPage();
    const gone: PlanStep = { action: 'click', target: { testid: 'gone', nth: 0 } };
    const readings = await readBuild(page, [[], [gone]], noSleep);
    expect(readings.get(sequenceKey([gone]))?.failedAt).toBe('click [testid=gone]');
  });

  it('lets a lost driver end the run, so it is never read as a difference', async () => {
    const page = counterPage();
    page.act = () => Promise.reject(new DriverLostError('no connected session with id s1'));
    await expect(readBuild(page, [[], [add]], noSleep)).rejects.toBeInstanceOf(DriverLostError);
  });
});

describe('probeSequence', () => {
  it('returns the settled tree after the last step, or undefined when a step failed', async () => {
    expect(await probeSequence(counterPage(), [add], noSleep)).toContain('[text="1"]');
    expect(await probeSequence(counterPage({ refuse: 'e1' }), [add], noSleep)).toBeUndefined();
  });
});
