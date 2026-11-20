import {
  ActionType,
  ElementState,
  EventType,
  ReticleCommand,
  parseInteractive,
} from '@reticlehq/core';
import { describe, expect, it } from 'vitest';

import { ActRefusal } from '../driver.js';
import type { ActOutcome, ActRequest, ReachAnswer, UiDriver, UiRead } from '../driver.js';
import { UiRole } from '../ui-node.js';
import type { UiNode } from '../ui-node.js';
import { PeerCommands } from './commands.js';

function node(role: UiRole, name: string, more: Partial<UiNode> = {}): UiNode {
  return { role, name, states: [], children: [], ...more };
}
function read(status: string): UiRead {
  const root = node(UiRole.WINDOW, 'Notes', {
    frame: [0, 0, 400, 300],
    children: [
      node(UiRole.BUTTON, 'Save', { frame: [10, 10, 80, 30] }),
      node(UiRole.BUTTON, 'Pay', { frame: [10, 50, 80, 30], states: [ElementState.DISABLED] }),
      node(UiRole.BUTTON, 'Below', { frame: [10, 900, 80, 30] }),
      node(UiRole.BUTTON, 'Delete note', { frame: [100, 10, 80, 30] }),
      node(UiRole.DIALOG, 'Send the report?', {
        frame: [50, 50, 200, 100],
        children: [node(UiRole.BUTTON, 'OK', { frame: [60, 100, 60, 30] })],
      }),
      node(UiRole.TEXT, status, { frame: [10, 90, 200, 20] }),
    ],
  });
  return { root, unread: 0, unmapped: [] };
}

/** What the fake operating system says when the peer asks if a person can see an element. */
let reachAnswer: ReachAnswer = { reach: 'yes' };

/** A driver for a test that asks the application nothing. */
function fakeDriver(): UiDriver {
  return {
    subject: () => ({ app: 'Notes', pid: 7 }),
    read: () => Promise.resolve(read('Ready')),
    reach: () => Promise.resolve(reachAnswer),
    act: () => Promise.reject(new Error('this test does not act')),
  };
}

function peer(outcome: Partial<ActOutcome> = {}) {
  reachAnswer = { reach: 'yes' };
  const asked: ActRequest[] = [];
  const events: [string, Record<string, unknown>][] = [];
  const driver: UiDriver = {
    subject: () => ({ app: 'Notes', pid: 7 }),
    read: () => Promise.resolve(read('Ready')),
    reach: () => Promise.resolve(reachAnswer),
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
  const commands = new PeerCommands({ driver, emit: (type, data) => events.push([type, data]) });
  return { commands, asked, events };
}

async function refOf(commands: PeerCommands, name: string): Promise<string> {
  const found = (await commands.answer(ReticleCommand.QUERY, { role: UiRole.BUTTON, name })) as {
    elements: { ref: string }[];
  };
  return found.elements[0]?.ref ?? '';
}

describe('PeerCommands', () => {
  it('answers a snapshot in the shape the server reads', async () => {
    const snapshot = (await peer().commands.answer(ReticleCommand.SNAPSHOT, {})) as {
      tree: string;
      status: { route: string; title: string };
      nodes: number;
      truncated: boolean;
    };
    expect(snapshot.status).toEqual({ route: '/', title: 'Notes' });
    expect(snapshot.nodes).toBe(8);
    expect(snapshot.truncated).toBe(false);
    expect(parseInteractive(snapshot.tree)).toHaveLength(8);
  });

  it('matches by role and exact name, and by text with the case the caller asked for', async () => {
    const { commands } = peer();
    const match = (query: Record<string, unknown>, more: Record<string, unknown> = {}) =>
      commands.answer(ReticleCommand.MATCH, { query, ...more }) as Promise<{
        matched: boolean;
        count: number;
      }>;
    expect((await match({ role: UiRole.BUTTON, name: 'Save' })).matched).toBe(true);
    expect((await match({ role: UiRole.BUTTON, name: 'Sav' })).matched).toBe(false);
    expect((await match({ text: 'ready' })).matched).toBe(true);
    expect((await match({ text: 'ready', matchCase: true })).matched).toBe(false);
    expect((await match({ text: 'Ready', matchCase: true })).count).toBe(1);
  });

  it('checks a state it can read, and refuses a state it cannot', async () => {
    const { commands } = peer();
    const match = (name: string, state: string) =>
      commands.answer(ReticleCommand.MATCH, {
        query: { role: UiRole.BUTTON, name },
        state,
      }) as Promise<{
        matched: boolean;
      }>;
    expect((await match('Save', ElementState.VISIBLE)).matched).toBe(true);
    expect((await match('Below', ElementState.VISIBLE)).matched).toBe(false);
    expect((await match('Pay', ElementState.DISABLED)).matched).toBe(true);
    expect((await match('Pay', ElementState.ENABLED)).matched).toBe(false);
    await expect(match('Save', ElementState.RECEIVES_POINTER)).rejects.toThrow(/not read/);
  });

  it('acts, sends what changed before it answers, and reports the action', async () => {
    const { commands, asked, events } = peer();
    const ref = await refOf(commands, 'Save');
    const result = (await commands.answer(ReticleCommand.ACT, {
      ref,
      action: ActionType.CLICK,
    })) as {
      ok: boolean;
      settled: boolean;
      role: string;
      name: string;
      effect: { domMutatedWithin: number };
    };
    expect(asked).toHaveLength(1);
    expect(events).toEqual([
      [EventType.DOM_REMOVED, { role: UiRole.TEXT, name: 'Ready' }],
      [EventType.DOM_ADDED, { role: UiRole.TEXT, name: 'Saved' }],
    ]);
    expect(result).toMatchObject({ ok: true, settled: true, role: UiRole.BUTTON, name: 'Save' });
    expect(result.effect.domMutatedWithin).toBe(2);
  });

  it('fails with the words the server knows when a ref is not an element now', async () => {
    const { commands, asked } = peer();
    await expect(
      commands.answer(ReticleCommand.ACT, { ref: 'e99', action: ActionType.CLICK }),
    ).rejects.toThrow("ref 'e99' no longer resolves to an element");
    expect(asked).toEqual([]);
  });

  it('refuses an action it cannot do like a person, and one it does not have', async () => {
    const { commands } = peer({ refused: ActRefusal.UNREACHABLE, delivered: false });
    const ref = await refOf(commands, 'Save');
    await expect(
      commands.answer(ReticleCommand.ACT, { ref, action: ActionType.CLICK }),
    ).rejects.toThrow(/a person cannot reach/);
    await expect(
      commands.answer(ReticleCommand.ACT, { ref, action: ActionType.DRAG }),
    ).rejects.toThrow(/does not have the action drag/);
  });

  it('sends a signal for a file the action wrote', async () => {
    const fact = { hash: 'h', size: 4, mode: 0o644, linkTo: undefined };
    // Three looks: at the start, before the action, and after it.
    const looks = [new Map(), new Map(), new Map([['/out/note.txt', fact]])];
    const events: [string, Record<string, unknown>][] = [];
    const commands = new PeerCommands({
      driver: {
        subject: () => ({ app: 'Notes', pid: 7 }),
        read: () => Promise.resolve(read('Ready')),
        reach: () => Promise.resolve(reachAnswer),
        act: () =>
          Promise.resolve({
            delivered: true,
            reachable: true,
            settled: true,
            before: read('Ready'),
            after: read('Ready'),
          }),
      },
      emit: (type, data) => events.push([type, data]),
      workspace: {
        roots: ['/out'],
        excluded: [],
        snapshot: () => ({ files: looks.shift() ?? new Map(), unreadable: [] }),
      },
    });
    const ref = await refOf(commands, 'Save');
    await commands.answer(ReticleCommand.ACT, { ref, action: ActionType.CLICK });
    expect(events).toEqual([
      [
        EventType.SIGNAL,
        { name: 'file.written', data: { file: 'note.txt', path: '/out/note.txt', size: 4 } },
      ],
    ]);
  });

  it('does several actions in one command, and names the step that failed', async () => {
    const { commands, asked } = peer();
    const save = await refOf(commands, 'Save');
    const result = (await commands.answer(ReticleCommand.ACT_SEQUENCE, {
      steps: [
        { ref: save, action: ActionType.CLICK },
        { ref: save, action: ActionType.CLICK },
      ],
    })) as { count: number; steps: { name: string; settled: boolean }[]; effects: unknown[] };
    expect(result.count).toBe(2);
    expect(result.steps.map((s) => s.name)).toEqual(['Save', 'Save']);
    expect(result.effects).toHaveLength(2);

    await expect(
      commands.answer(ReticleCommand.ACT_SEQUENCE, {
        steps: [
          { ref: save, action: ActionType.CLICK },
          { ref: 'e99', action: ActionType.CLICK },
        ],
      }),
    ).rejects.toThrow("step 2 of 2: ref 'e99' no longer resolves to an element");
    expect(asked).toHaveLength(3);
  });

  it('types with key events, and presses a key with its modifiers', async () => {
    const { commands, asked } = peer();
    const ref = await refOf(commands, 'Save');
    await commands.answer(ReticleCommand.ACT, {
      ref,
      action: ActionType.TYPE,
      args: { text: 'Plan' },
    });
    await commands.answer(ReticleCommand.ACT, {
      ref,
      action: ActionType.PRESS,
      args: { text: 's', modifiers: ['Meta', 'Shift'] },
    });
    expect(asked.map((a) => [a.kind, a.value])).toEqual([
      ['type', 'Plan'],
      ['key', 'Meta+Shift+s'],
    ]);
  });

  it('presses no outward control that a Harness command did not ask for', async () => {
    const { commands, asked } = peer();
    const ref = await refOf(commands, 'Delete note');
    const click = { ref, action: ActionType.CLICK };
    await expect(commands.answer(ReticleCommand.ACT, click, [])).rejects.toThrow(/delete/i);
    expect(asked).toEqual([]);
    await commands.answer(ReticleCommand.ACT, click, ['delete']);
    await commands.answer(ReticleCommand.ACT, click);
    expect(asked).toHaveLength(2);
    // A plain name in a dialog that asks about an outward action.
    const ok = { ref: await refOf(commands, 'OK'), action: ActionType.CLICK };
    await expect(commands.answer(ReticleCommand.ACT, ok, [])).rejects.toThrow(/send/i);
    expect(asked).toHaveLength(2);
  });

  it('scrolls by a move of the scroll bar, and says when it took a step and not pixels', async () => {
    const list = (bar: string): UiRead => ({
      root: node(UiRole.WINDOW, 'Notes', {
        frame: [0, 0, 400, 300],
        children: [
          node(UiRole.GROUP, 'Rows', {
            frame: [0, 0, 300, 300],
            children: [
              node(UiRole.BUTTON, 'Row 1', { frame: [0, 0, 100, 20] }),
              node(UiRole.SCROLLBAR, '', { frame: [285, 0, 15, 300], value: bar }),
            ],
          }),
        ],
      }),
      unread: 0,
      unmapped: [],
    });
    const asked: ActRequest[] = [];
    const commands = new PeerCommands({
      driver: {
        subject: () => ({ app: 'Notes', pid: 7 }),
        read: () => Promise.resolve(list('0.5')),
        reach: () => Promise.resolve(reachAnswer),
        act: (request) => {
          asked.push(request);
          return Promise.resolve({
            delivered: true,
            reachable: false,
            settled: true,
            before: list('0.5'),
            after: list(request.value ?? ''),
          });
        },
      },
      emit: () => undefined,
    });
    const row = await refOf(commands, 'Row 1');
    expect(await commands.answer(ReticleCommand.SCROLL, { ref: row, fraction: 1 })).toEqual({
      scrolled: true,
      atEnd: true,
      fraction: 1,
    });
    expect(await commands.answer(ReticleCommand.SCROLL, { ref: row, dy: 400 })).toEqual({
      scrolled: true,
      atEnd: false,
      fraction: 0.6,
      stepInsteadOfPixels: 0.1,
    });
    expect(asked.map((a) => [a.kind, a.value, a.target.node.role])).toEqual([
      ['set', '1', 'scrollbar'],
      ['set', '0.6', 'scrollbar'],
    ]);
    // The tools send a scroll as an action too. It is the same scroll, and the answer says so.
    const acted = (await commands.answer(ReticleCommand.ACT, {
      ref: row,
      action: ActionType.SCROLL,
      args: { fraction: 0 },
    })) as { ok: boolean; effect: { scrolled: boolean; atEnd: boolean; fraction: number } };
    expect(acted.ok).toBe(true);
    expect(acted.effect).toMatchObject({ scrolled: true, atEnd: true, fraction: 0 });
    await expect(peer().commands.answer(ReticleCommand.SCROLL, {})).rejects.toThrow(
      /no scroll bar/,
    );
  });

  it('does not call an element visible when a window is on top of it', async () => {
    const { commands } = peer();
    const visible = () =>
      commands.answer(ReticleCommand.MATCH, {
        query: { role: UiRole.BUTTON, name: 'Save' },
        state: ElementState.VISIBLE,
      }) as Promise<{ matched: boolean }>;
    expect((await visible()).matched).toBe(true);

    reachAnswer = { reach: 'no', detail: 'AXWindow "Mail" of Mail' };
    expect((await visible()).matched).toBe(false);

    // The same element is hidden then: the two states are never both true or both false.
    const hidden = (name: string) =>
      commands.answer(ReticleCommand.MATCH, {
        query: { role: UiRole.BUTTON, name },
        state: ElementState.HIDDEN,
      }) as Promise<{ matched: boolean }>;
    expect((await hidden('Save')).matched).toBe(true);
    reachAnswer = { reach: 'yes' };
    expect((await hidden('Save')).matched).toBe(false);
    // An element with no place in its window is hidden with no question to the operating system.
    expect((await hidden('Below')).matched).toBe(true);

    // The operating system did not answer: the check fails with words, so the caller gets "not known".
    reachAnswer = { reach: 'unknown', detail: 'the hit test failed with -25200' };
    await expect(visible()).rejects.toThrow(/could not tell if a person can see button "Save"/);
  });

  it('sends a signal for a file that comes after the action is finished, and sends it once', () => {
    const fact = { hash: 'h', size: 4, mode: 0o644, linkTo: undefined };
    let files = new Map<string, typeof fact>([['/out/old.txt', fact]]);
    let written = 1;
    const events: [string, Record<string, unknown>][] = [];
    const commands = new PeerCommands({
      driver: fakeDriver(),
      emit: (type, data) => events.push([type, data]),
      workspace: {
        roots: ['/out'],
        excluded: [],
        snapshot: () => ({ files: new Map(files), unreadable: [] }),
      },
      writeTimeOf: (path) => ('/out/old.txt' === path ? written : 1),
    });
    // A file that was there at the start is not a change.
    commands.sendFileChanges();
    expect(events).toEqual([]);

    files = new Map([...files, ['/out/late.txt', fact]]);
    commands.sendFileChanges();
    commands.sendFileChanges();
    expect(events.map(([, data]) => data['name'])).toEqual(['file.written']);

    // The same bytes, written again: the snapshot is the same, and the write time is new.
    written = 2;
    commands.sendFileChanges();
    commands.sendFileChanges();
    expect(events.map(([, data]) => data['name'])).toEqual(['file.written', 'file.written']);
    expect(events[1]?.[1]['data']).toMatchObject({ file: 'old.txt', kind: 'rewritten' });
  });

  it('sends a signal when the process wrote bytes to disk, and none when it wrote nothing', async () => {
    const wrote = peer({ bytesWritten: 4096 });
    await wrote.commands.answer(ReticleCommand.ACT, {
      ref: await refOf(wrote.commands, 'Save'),
      action: ActionType.CLICK,
    });
    expect(wrote.events).toContainEqual([
      EventType.SIGNAL,
      { name: 'disk.wrote', data: { bytes: 4096 } },
    ]);

    const nothing = peer({ bytesWritten: 0 });
    await nothing.commands.answer(ReticleCommand.ACT, {
      ref: await refOf(nothing.commands, 'Save'),
      action: ActionType.CLICK,
    });
    expect(nothing.events.filter(([type]) => EventType.SIGNAL === type)).toEqual([]);
  });

  it('says what changed in the tree between actions, once, and not while an action runs', async () => {
    let status = 'Ready';
    const events: [string, Record<string, unknown>][] = [];
    let release: (() => void) | undefined;
    const commands = new PeerCommands({
      driver: {
        subject: () => ({ app: 'Notes', pid: 7 }),
        read: () => Promise.resolve(read(status)),
        reach: () => Promise.resolve({ reach: 'yes' }),
        act: (request) =>
          new Promise((resolve) => {
            // The action is asked for a short quiet time, because the peer goes on looking.
            expect(request.quietMs).toBe(150);
            release = () => {
              resolve({
                delivered: true,
                reachable: true,
                settled: true,
                before: read('Ready'),
                after: read('Working'),
              });
            };
          }),
      },
      emit: (type, data) => events.push([type, data]),
    });
    // The first look has nothing to compare with.
    await commands.sendTreeChanges();
    expect(events).toEqual([]);

    const ref = await refOf(commands, 'Save');
    const acting = commands.answer(ReticleCommand.ACT, { ref, action: ActionType.CLICK });
    await new Promise((resolve) => setTimeout(resolve, 10));
    status = 'Working';
    // An action is in progress: it says its own changes, so the look says nothing.
    await commands.sendTreeChanges();
    expect(events).toEqual([]);
    release?.();
    await acting;
    expect(events.map(([, data]) => data['name'])).toEqual(['Ready', 'Working']);

    // The second step of the effect comes after the action is finished. The look sends it, once.
    status = 'Done';
    await commands.sendTreeChanges();
    await commands.sendTreeChanges();
    expect(events.map(([, data]) => data['name'])).toEqual(['Ready', 'Working', 'Working', 'Done']);
  });

  it('sends a signal for a setting that the action changed', async () => {
    const changed = peer({
      settingsChanged: [
        { key: 'remember', old: '', new: '1' },
        { key: 'recent', old: 'a'.repeat(200), new: 'a'.repeat(200), cut: true },
      ],
    });
    await changed.commands.answer(ReticleCommand.ACT, {
      ref: await refOf(changed.commands, 'Save'),
      action: ActionType.CLICK,
    });
    expect(changed.events).toContainEqual([
      EventType.SIGNAL,
      { name: 'settings.changed', data: { key: 'remember', old: '', value: '1' } },
    ]);
    // A long value is given in part, and the signal says so: the two texts are the same here, and
    // the values are not.
    const long = changed.events.find(
      ([, data]) => 'recent' === (data['data'] as { key?: string } | undefined)?.key,
    );
    expect(long?.[1]['data']).toMatchObject({ cut: true });
  });
});
