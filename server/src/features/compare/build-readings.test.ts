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
function counterPage(
  opts: { refuse?: string; trees?: string[]; effects?: (since: number) => string[] } = {},
): PageDriver & {
  reads: number;
  opens: number;
  acts: string[];
  cursors: number[];
} {
  let count = 0;
  let clock = 100;
  const page = {
    reads: 0,
    opens: 0,
    acts: [] as string[],
    cursors: [] as number[],
    effects: (since: number) => {
      page.cursors.push(since);
      return Promise.resolve(opts.effects?.(since) ?? []);
    },
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
      clock += 1;
      if (ref === opts.refuse) {
        return Promise.resolve({ ok: false, since: clock });
      }
      count += 1;
      return Promise.resolve({ ok: true, since: clock });
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

  it('clicks a text probe by its text, because a text line has no ref', async () => {
    const page = counterPage();
    const probe: PlanStep = { action: 'click', target: { text: 'Count', nth: 0 } };
    const at: unknown[] = [];
    page.act = (ref: unknown) => {
      at.push(ref);
      return Promise.resolve({ ok: true });
    };
    const readings = await readBuild(page, [[], [probe]], noSleep);
    expect(at).toEqual([{ text: 'Count' }]);
    expect(readings.get(sequenceKey([probe]))?.actions).toEqual([START_STEP, 'click text "Count"']);
  });

  it('opens a url parameter value on the same tab, and fails the step on a driver that cannot', async () => {
    const page = counterPage();
    const opened: string[] = [];
    const root: PlanStep = { action: 'goto', query: '?view=grid' };
    const withGoto = {
      ...page,
      goto: (query: string) => {
        opened.push(query);
        return Promise.resolve(true);
      },
    };
    const readings = await readBuild(withGoto, [[], [root]], noSleep);
    expect(opened).toEqual(['?view=grid']);
    expect(readings.get(sequenceKey([root]))?.lines).toBeDefined();
    const without = await readBuild(counterPage(), [[], [root]], noSleep);
    expect(without.get(sequenceKey([root]))?.failedAt).toBe('open "?view=grid"');
  });

  it('lets a lost driver end the run, so it is never read as a difference', async () => {
    const page = counterPage();
    page.act = () => Promise.reject(new DriverLostError('no connected session with id s1'));
    await expect(readBuild(page, [[], [add]], noSleep)).rejects.toBeInstanceOf(DriverLostError);
  });
});

describe('what the app did', () => {
  it('adds the network calls and console errors since the sequence began to each reading', async () => {
    const page = counterPage({ effects: () => ['net: POST /api/add 500'] });
    const readings = await readBuild(page, [[], [add], [add, add]], noSleep);
    expect(readings.get(sequenceKey([add, add]))?.lines).toEqual([
      'button add',
      'count 2',
      'button other',
      'net: POST /api/add 500',
    ]);
    // Read from the cursor of the run's FIRST act, for every step of the run.
    expect(new Set(page.cursors)).toEqual(new Set([101]));
    // The start page has no action yet, so it has no effects.
    expect(readings.get(sequenceKey([]))?.lines).not.toContain('net: POST /api/add 500');
  });
});

describe('probeSequence', () => {
  const wait: PlanStep = { action: 'wait', ms: 4000 };

  it('returns the settled tree after the last step, or undefined when a step failed', async () => {
    expect((await probeSequence(counterPage(), [add], noSleep))?.tree).toContain('[text="1"]');
    expect(await probeSequence(counterPage({ refuse: 'e1' }), [add], noSleep)).toBeUndefined();
  });

  it('calls a wait quiet when nothing changed during it and nothing was pending', async () => {
    expect((await probeSequence(counterPage(), [add, wait], noSleep))?.active).toBe(false);
  });

  it('calls a wait active when the page changed during it', async () => {
    const page = counterPage();
    let waited = false;
    const plain = counterPage();
    page.read = () => (waited ? Promise.resolve('- status "Toast" [text="Saved"]') : plain.read());
    const sleep = (ms: number): Promise<void> => {
      waited ||= 4000 === ms;
      return Promise.resolve();
    };
    expect((await probeSequence(page, [add, wait], sleep))?.active).toBe(true);
  });

  it('calls a wait active when a network call was still pending before it', async () => {
    const page = counterPage({ effects: () => ['net: GET /slow pending'] });
    expect((await probeSequence(page, [add, wait], noSleep))?.active).toBe(true);
  });
});
