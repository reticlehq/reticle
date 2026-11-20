import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ActKind, ActRefusal, Delivery } from '../driver.js';
import { place } from '../ui-node.js';
import { MacDriver } from './mac-driver.js';

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
});
