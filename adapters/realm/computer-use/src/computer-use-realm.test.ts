import { BlindSpotKind, CloseCondition, RefusalReason } from 'open-verification';
import type { Action } from 'open-verification';
import { describe, expect, it } from 'vitest';

import { CuChannel, CuSummary } from './channels.js';
import { ComputerUseRealm } from './computer-use-realm.js';
import { ActKind, ActRefusal } from './driver.js';
import type { ActOutcome, ActRequest, UiDriver, UiRead } from './driver.js';
import { UiRole } from './ui-node.js';
import type { UiNode } from './ui-node.js';

function node(role: UiRole, name: string, children: UiNode[] = []): UiNode {
  return { role, name, states: [], children };
}
function read(status: string, unread = 0): UiRead {
  const root = node(UiRole.WINDOW, 'Notes', [
    node(UiRole.BUTTON, 'Save'),
    node(UiRole.TEXT, status),
  ]);
  return { root, unread, unmapped: [] };
}

/** An application that answers each action with the outcome the test chose. */
function driver(outcome: Partial<ActOutcome> = {}): UiDriver & { asked: ActRequest[] } {
  const asked: ActRequest[] = [];
  return {
    asked,
    subject: () => ({ app: 'Notes', pid: 7 }),
    read: () => Promise.resolve(read('Ready')),
    act: (request) => {
      asked.push(request);
      return Promise.resolve({
        delivered: true,
        reachable: true,
        settled: true,
        before: read('Ready'),
        after: read('Saved'),
        ...outcome,
      });
    },
  };
}

function press(target: string): Action {
  return { id: 'a1', actor: 'agent', capability: ActKind.PRESS, target, at: 0 };
}

async function refOf(realm: ComputerUseRealm, name: string): Promise<string> {
  const handles = await realm.locate({ name });
  return handles[0]?.ref ?? '';
}

describe('ComputerUseRealm', () => {
  it('describes the application as lines, and finds an element by its name', async () => {
    const realm = new ComputerUseRealm({ driver: driver(), now: () => 0 });
    const described = await realm.describe();
    expect(described.tree.split('\n')[1]).toBe('  - button "Save" (ref=e2)');
    expect(await realm.locate({ name: 'Save' })).toEqual([
      { ref: 'e2', describes: 'button "Save"' },
    ]);
  });

  it('offers no target that has no place on the screen, and counts the windows', async () => {
    const menuOnly: UiRead = {
      root: node(UiRole.APPLICATION, 'Calculator', [
        node(UiRole.MENU, '', [
          { ...node(UiRole.MENUITEM, '7'), frame: [0, 900, 0, 0] },
          { ...node(UiRole.MENUITEM, 'View'), frame: [10, 0, 40, 30] },
        ]),
      ]),
      unread: 0,
      unmapped: [],
    };
    const realm = new ComputerUseRealm({
      driver: { ...driver(), read: () => Promise.resolve(menuOnly) },
      now: () => 0,
    });
    expect(await realm.locate({ name: '7' })).toEqual([]);
    expect(await realm.locate({ name: 'View' })).toHaveLength(1);
    const described = await realm.describe();
    expect(described.windows).toBe(0);
    expect(described.omitted).toBe(1);
  });

  it('reports what an action changed', async () => {
    const realm = new ComputerUseRealm({ driver: driver(), now: () => 0 });
    const window = realm.openWindow(1000);
    const receipt = await realm.perform(press(await refOf(realm, 'Save')));
    expect(receipt.dispatched).toBe(true);
    const seen = await realm.observe(realm.closeWindow(window));
    expect(seen.map((o) => [o.channel, o.summary, o.value])).toEqual([
      [CuChannel.UI, CuSummary.UI_GONE, { element: 'text "Ready"' }],
      [CuChannel.UI, CuSummary.UI_APPEARED, { element: 'text "Saved"' }],
    ]);
  });

  it('says so when a delivered action changed nothing', async () => {
    const realm = new ComputerUseRealm({ driver: driver({ after: read('Ready') }), now: () => 0 });
    const window = realm.openWindow(1000);
    await realm.perform(press(await refOf(realm, 'Save')));
    const seen = await realm.observe(realm.closeWindow(window));
    expect(seen.map((o) => o.summary)).toEqual([CuSummary.UI_NO_EFFECT]);
  });

  it('refuses a ref it never gave, and an element a person cannot reach', async () => {
    const blocked = driver({ refused: ActRefusal.UNREACHABLE, delivered: false });
    const realm = new ComputerUseRealm({ driver: blocked, now: () => 0 });
    realm.openWindow(1000);
    expect((await realm.perform(press('e99'))).refused?.reason).toBe(RefusalReason.UNRESOLVED);
    expect(blocked.asked).toEqual([]);
    const receipt = await realm.perform(press(await refOf(realm, 'Save')));
    expect(receipt.dispatched).toBe(false);
    expect(receipt.refused?.reason).toBe(RefusalReason.GUARDED);
  });

  it('gives each window only its own actions', async () => {
    const realm = new ComputerUseRealm({ driver: driver(), now: () => 0 });
    const first = realm.openWindow(1000);
    await realm.perform(press(await refOf(realm, 'Save')));
    expect(await realm.observe(realm.closeWindow(first))).toHaveLength(2);
    const second = realm.openWindow(1000);
    await realm.perform(press('e99'));
    expect(await realm.observe(realm.closeWindow(second))).toEqual([]);
  });

  it('closes a window by what ended it', async () => {
    const realm = new ComputerUseRealm({ driver: driver({ settled: false }), now: () => 0 });
    const window = realm.openWindow(1000);
    await realm.perform(press(await refOf(realm, 'Save')));
    expect(realm.closeWindow(window).closedBy).toBe(CloseCondition.BUDGET_EXHAUSTED);
  });

  it('cannot prove anything from the tree alone, and says what it did not see', async () => {
    const holes = driver({ after: read('Saved', 2) });
    const realm = new ComputerUseRealm({ driver: holes, now: () => 0 });
    expect(realm.canProveAnything()).toBe(false);
    const window = realm.openWindow(1000);
    await realm.perform(press(await refOf(realm, 'Save')));
    const coverage = await realm.coverage(realm.closeWindow(window));
    expect(coverage.blindSpots.map((b) => [b.kind, b.impeaching])).toEqual([
      [BlindSpotKind.CHANNEL_UNOBSERVED, false],
      [BlindSpotKind.BUFFER_TRUNCATED, true],
    ]);
  });

  it('can prove a claim about files when a folder is watched', () => {
    const workspace = {
      roots: ['/tmp/x'],
      excluded: [],
      snapshot: () => ({ files: new Map(), unreadable: [] }),
    };
    const realm = new ComputerUseRealm({ driver: driver(), workspace, now: () => 0 });
    expect(realm.canProveAnything()).toBe(true);
  });
});
