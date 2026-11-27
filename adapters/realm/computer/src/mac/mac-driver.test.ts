import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ActKind, ActRefusal, Delivery } from '../driver.js';
import { place } from '../ui-node.js';
import { MacDriver, removeCaptures } from './mac-driver.js';

const tree: unknown = JSON.parse(
  readFileSync(new URL('recorded/fixture-app.json', import.meta.url), 'utf8'),
);

function driverAnswering(act: unknown): { driver: MacDriver; calls: string[][] } {
  const calls: string[][] = [];
  const driver = new MacDriver({
    helper: 'reticle-ax',
    app: 'fixture',
    pid: 7,
    run: (_file, args) => {
      calls.push([...args]);
      const answer = 'tree' === args[0] ? { tree, unread: 0, windowsNotOnScreen: 2 } : act;
      return Promise.resolve(JSON.stringify(answer));
    },
  });
  return { driver, calls };
}

describe('MacDriver', () => {
  // The daemon deletes a picture after it reads it. A picture it never read (a command that timed
  // out, a read that failed) stayed in the temporary folder: 25 pictures of a person's screen were
  // found there after two days of work. The driver removes every picture it wrote when it stops.
  it('removes the pictures it wrote when it stops', async () => {
    const driver = new MacDriver({
      helper: 'reticle-ax',
      app: 'fixture',
      pid: 7,
      run: (_file, args) => {
        if ('tree' === args[0]) {
          return Promise.resolve(JSON.stringify({ tree, unread: 0 }));
        }
        writeFileSync(args[2] ?? '', 'png');
        return Promise.resolve(JSON.stringify({ ok: true, window: [0, 0, 10, 10], scale: 1 }));
      },
    });
    const taken = await driver.capture();
    const path = taken.ok ? taken.path : '';
    expect(existsSync(path)).toBe(true);
    removeCaptures();
    expect(existsSync(path)).toBe(false);
  });

  // Numbers gives its sheet only to a screen reader. Under Stage Manager an application opened in
  // the background has no window on the screen, so a test of the switch at join time saw nothing
  // to compare. The driver tries the switch at the first read that has a window, and once.
  it('tries the screen reader switch once, at the first read that has a window', async () => {
    const calls: string[][] = [];
    let windows: unknown[] = [];
    const driver = new MacDriver({
      helper: 'reticle-ax',
      app: 'Numbers',
      pid: 7,
      screenReaderSwitch: true,
      run: (_file, args) => {
        calls.push([...args]);
        const answer =
          'tree' === args[0]
            ? { tree: { role: 'AXApplication', children: windows }, unread: 0 }
            : { set: true };
        return Promise.resolve(JSON.stringify(answer));
      },
    });
    await driver.read();
    expect(calls.filter(([command]) => 'web-tree' === command)).toEqual([]);
    windows = [{ role: 'AXWindow', title: 'costs', children: [] }];
    await driver.read();
    await driver.read();
    expect(calls.filter(([command]) => 'web-tree' === command)).toEqual([['web-tree', '7', 'try']]);
  });

  it('asks the helper for the element it last read at that place', async () => {
    const { driver, calls } = driverAnswering({
      delivered: true,
      reachable: true,
      settled: true,
      before: tree,
      after: tree,
      unreadBefore: 0,
      unreadAfter: 1,
    });
    const read = await driver.read();
    expect(read.windowsNotOnScreen).toBe(2);
    const save = place(read.root).find((p) => 'Save' === p.node.name);
    expect(save).toBeDefined();
    if (save === undefined) {
      return;
    }
    const outcome = await driver.act({
      target: save,
      kind: ActKind.PRESS,
      delivery: Delivery.USER_PATH,
      budgetMs: 500,
      watch: ['/tmp/out'],
    });
    expect(calls[1]).toEqual([
      'act',
      '7',
      '0.2',
      'AXButton',
      'Save',
      'press',
      '',
      '500',
      'user-path',
      '/tmp/out',
    ]);
    expect(outcome.delivered).toBe(true);
    expect(outcome.after.unread).toBe(1);
  });

  it('passes a refusal on, and refuses by itself before any read', async () => {
    const { driver, calls } = driverAnswering({ refused: 'unreachable' });
    const read = await driver.read();
    const target = place(read.root)[2];
    expect(target).toBeDefined();
    if (target === undefined) {
      return;
    }
    const request = {
      target,
      kind: ActKind.PRESS,
      delivery: Delivery.USER_PATH,
      budgetMs: 500,
      watch: [],
    };
    expect((await driver.act(request)).refused).toBe(ActRefusal.UNREACHABLE);

    const fresh = driverAnswering({}).driver;
    expect((await fresh.act(request)).refused).toBe(ActRefusal.STALE);
    expect(calls).toHaveLength(2);
  });

  it('fails loudly when the helper has no permission', async () => {
    const driver = new MacDriver({
      helper: 'reticle-ax',
      app: 'fixture',
      pid: 7,
      run: () => Promise.resolve(JSON.stringify({ error: 'not-trusted' })),
    });
    await expect(driver.read()).rejects.toThrow(/Accessibility/);
  });

  it('says that the application is not running, when the helper finds no process', async () => {
    const driver = new MacDriver({
      helper: 'reticle-ax',
      app: 'fixture',
      pid: 7,
      run: () => Promise.resolve(JSON.stringify({ error: 'app-gone' })),
    });
    await expect(driver.read()).rejects.toThrow(/fixture \(7\) is not running/);
  });

  // With the screen locked the application read as one with no window, and an agent then looked
  // for a window that was there all the time.
  it('says that the screen is locked, when the helper finds it so', async () => {
    const driver = new MacDriver({
      helper: 'reticle-ax',
      app: 'fixture',
      pid: 7,
      run: () => Promise.resolve(JSON.stringify({ error: 'screen-locked' })),
    });
    await expect(driver.read()).rejects.toThrow(/The screen is locked/);
  });

  // A realm that can read the window of Reticle can press Resume in it, and Pause is then no stop.
  it('does not read or act on the window of Reticle itself', async () => {
    const driver = new MacDriver({
      helper: 'reticle-ax',
      app: 'reticle-hud',
      pid: 7,
      run: () => Promise.resolve(JSON.stringify({ error: 'own-window' })),
    });
    await expect(driver.read()).rejects.toThrow(/the window of Reticle itself/);
  });
});
