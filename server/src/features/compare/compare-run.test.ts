import { describe, expect, it } from 'vitest';
import { DifferenceKind } from './compare-diff.js';
import { compareBuilds, type CompareDriver } from './compare-run.js';

/*
 * A small app: a start page with an "Open" button and a name field, and a panel the button opens.
 * `build` says what differs between builds: the panel's text, whether "Close" exists, and a clock.
 */
interface Build {
  panel: string;
  /** False: the "Close" button shows, and does nothing. */
  close?: boolean;
  clock?: () => string;
}

function fakeDriver(build: Build, log: string[]): CompareDriver {
  let page = 'home';
  let typed = '';
  const tree = (): string => {
    const clock = build.clock === undefined ? '' : `\n- text "${build.clock()}"`;
    if ('home' === page) {
      const value = typed.length > 0 ? ` [value="${typed}"]` : '';
      return `- textbox "Name" (ref=e1)${value}\n- button "Open" (ref=e2)${clock}`;
    }
    const close = '\n- button "Close" (ref=e3)';
    return `- text "${build.panel}"${close}${clock}`;
  };
  const click = (ref: string): boolean => {
    if ('e2' === ref && 'home' === page) {
      page = 'panel';
      return true;
    }
    if ('e3' === ref && 'panel' === page && false !== build.close) {
      page = 'home';
      return true;
    }
    return false;
  };
  return {
    reset: () => {
      page = 'home';
      typed = '';
      return Promise.resolve(true);
    },
    look: () => Promise.resolve({ tree: tree(), route: `/${page}` }),
    read: () => Promise.resolve(tree()),
    act: (ref, action, value) => {
      log.push(`${action} ${ref}${value === undefined ? '' : ` ${value}`}`);
      if ('fill' === action && 'e1' === ref) {
        typed = value ?? '';
        return Promise.resolve({ ok: true, events: [] });
      }
      return Promise.resolve({ ok: click(ref), events: [] });
    },
    replayStep: (_flow, index) => {
      if (0 === index) {
        page = 'home';
      }
      const done = click(0 === index ? 'e2' : 'e3');
      return Promise.resolve({ done, label: 0 === index ? 'click open' : 'click close' });
    },
    close: () => Promise.resolve(),
  };
}

const run = (reference: Build, candidate: Build, flows = [{ name: 'panel', steps: 2 }]) => {
  const log: string[] = [];
  return {
    log,
    result: compareBuilds({
      reference: 'http://ref',
      candidate: 'http://cand',
      open: (url) => Promise.resolve(fakeDriver('http://ref' === url ? reference : candidate, log)),
      flows,
      maxActions: 50,
      wait: () => Promise.resolve(),
    }),
  };
};

describe('compareBuilds', () => {
  it('finds no difference between two identical builds', async () => {
    const result = await run({ panel: 'Hello' }, { panel: 'Hello' }).result;
    expect(result.differences).toEqual([]);
    expect(result.compared).toBeGreaterThan(0);
  });

  it('reports the one text that differs, with the actions that showed it', async () => {
    const result = await run({ panel: 'Hello' }, { panel: 'Goodbye' }).result;
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]).toMatchObject({
      kind: DifferenceKind.CHANGED,
      removed: ['hello'],
      added: ['goodbye'],
    });
    expect(result.differences[0]?.actions.at(-1)).toContain('open');
  });

  it('reports a flow step the candidate could not do', async () => {
    const result = await run({ panel: 'Hello' }, { panel: 'Hello', close: false }).result;
    const unreached = result.differences.filter((d) => DifferenceKind.UNREACHED === d.kind);
    // Once for the flow's step, and once for the explorer's click on the same lost control.
    expect(unreached.map((d) => d.actions)).toEqual([
      ['flow "panel" step 1: click open', 'flow "panel" step 2: click close'],
      ['fill textbox "Name" with "text 1"', 'click button "Open"', 'click button "Close"'],
    ]);
  });

  it('ignores a clock that changes on every run', async () => {
    let tick = 0;
    const clock = (): string => `time ${String((tick += 1))}`;
    const result = await run({ panel: 'Hello', clock }, { panel: 'Hello', clock }).result;
    expect(result.differences).toEqual([]);
    expect(result.ignored).toBeGreaterThan(0);
  });

  it('types a value into the field before each click, and gives the same output on each run', async () => {
    const first = run({ panel: 'Hello' }, { panel: 'Goodbye' });
    const a = await first.result;
    const b = await run({ panel: 'Hello' }, { panel: 'Goodbye' }).result;
    expect(first.log).toContain('fill e1 text 1');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
