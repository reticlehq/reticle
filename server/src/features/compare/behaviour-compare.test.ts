import { describe, expect, it } from 'vitest';
import { CompareVerdict } from './behaviour-diff.js';
import { runCompare, type OpenedPage } from './behaviour-compare.js';
import { DriverLostError } from './build-readings.js';

/** A cart page. `step` is how much one click on Add adds: 1 on a good build. */
function cart(step: number, opened: string[], url: string, lose = false): OpenedPage {
  let total = 0;
  opened.push(url);
  return {
    open: () => {
      total = 0;
      return Promise.resolve(true);
    },
    read: () =>
      Promise.resolve(
        `- button "Add" (ref=e1) [testid=add]\n- status "Total" [text="${String(total)}"]`,
      ),
    act: () => {
      if (lose) {
        return Promise.reject(new DriverLostError('no connected session with id s1'));
      }
      total += step;
      return Promise.resolve({ ok: true, since: 1 });
    },
    effects: () => Promise.resolve([]),
    close: () => Promise.resolve(),
  };
}

const sleep = (): Promise<void> => Promise.resolve();
const noScripts = (): Promise<string | undefined> => Promise.resolve(undefined);
let clock = 0;
const now = (): number => (clock += 1000);

describe('runCompare', () => {
  it('is the same when both builds behave the same', async () => {
    const opened: string[] = [];
    const { result } = await runCompare({
      reference: 'ref',
      candidate: 'cand',
      open: (url) => Promise.resolve(cart(1, opened, url)),
      sleep,
      now,
      fetchText: noScripts,
    });
    expect(result.verdict).toBe(CompareVerdict.SAME);
    expect(result.compared).toBe(result.sequences);
    // The plan, then the reference, the candidate, and the reference again.
    expect(opened).toEqual(['ref', 'ref', 'cand', 'ref']);
  });

  it('reports the behaviour a changed build shows, with the steps that reproduce it', async () => {
    const { result, timings } = await runCompare({
      reference: 'ref',
      candidate: 'cand',
      base: 'base',
      open: (url) => Promise.resolve(cart('cand' === url ? 2 : 1, [], url)),
      sleep,
      now,
      fetchText: noScripts,
    });
    expect(result.verdict).toBe(CompareVerdict.DIFFERENT);
    expect(result.differences[0]).toMatchObject({
      actions: ['open the start page', 'click [testid=add]'],
      removed: ['total 1'],
      added: ['total 2'],
      tag: 'regression',
    });
    expect(timings?.base).toBeGreaterThan(0);
  });

  it('reports a build whose page is the same but whose request is wrong', async () => {
    // The page shows the same total on both builds; only the request body differs.
    const withRequest = (url: string): OpenedPage => {
      const page = cart(1, [], url);
      return {
        ...page,
        effects: () =>
          Promise.resolve([`net: POST /api/cart 200 {"qty":${'cand' === url ? '2' : '1'}}`]),
      };
    };
    const { result } = await runCompare({
      reference: 'ref',
      candidate: 'cand',
      open: (url) => Promise.resolve(withRequest(url)),
      sleep,
      now,
      fetchText: noScripts,
    });
    expect(result.verdict).toBe(CompareVerdict.DIFFERENT);
    expect(result.differences[0]).toMatchObject({
      removed: ['net: POST /api/cart 200 {"qty":1}'],
      added: ['net: POST /api/cart 200 {"qty":2}'],
    });
  });

  it('reaches a branch behind a value the app compares a field with', async () => {
    // Typing "progress" into Route opens a step; the candidate shows the wrong step title there.
    const routed = (url: string): OpenedPage => {
      let route = '';
      return {
        open: () => {
          route = '';
          return Promise.resolve(true);
        },
        read: () =>
          Promise.resolve(
            `- textbox "Route" (ref=e1) [value="${route}"]` +
              ('progress' === route ? `\n- heading "${'cand' === url ? 'Step 3' : 'Step 2'}"` : ''),
          ),
        act: (_ref, _action, value) => {
          route = value ?? '';
          return Promise.resolve({ ok: true, since: 1 });
        },
        effects: () => Promise.resolve([]),
        close: () => Promise.resolve(),
      };
    };
    const scripts: Record<string, string> = {
      ref: '<script src="/app.js"></script>',
      '/app.js': 'if(values.route==="progress"){}',
    };
    const { result } = await runCompare({
      reference: 'ref',
      candidate: 'cand',
      open: (url) => Promise.resolve(routed(url)),
      sleep,
      now,
      fetchText: (url) =>
        Promise.resolve(scripts[url.replace(/^http:\/\/[^/]+/, '')] ?? scripts[url]),
    });
    expect(result.verdict).toBe(CompareVerdict.DIFFERENT);
    expect(result.differences[0]?.actions).toContain('fill textbox "Route" with "progress"');
  });

  it('is invalid, not different, when the driver loses its session', async () => {
    const { result } = await runCompare({
      reference: 'ref',
      candidate: 'cand',
      open: (url) => Promise.resolve(cart(1, [], url, 'cand' === url)),
      sleep,
      now,
      fetchText: noScripts,
    });
    expect(result.verdict).toBe(CompareVerdict.INVALID);
    expect(result.reason).toContain('no connected session');
  });
});
