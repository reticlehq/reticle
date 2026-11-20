import {
  ActionType,
  ElementState,
  EventType,
  ReticleCommand,
  parseInteractive,
} from '@reticlehq/core';
import { describe, expect, it } from 'vitest';

import { ActKind, ActRefusal } from '../driver.js';
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

  it('does not report a change the application makes by itself as the effect of an action', async () => {
    // A window with a tip that rotates, in its own group, and a status that only an action changes.
    const shown = (tip: string, status: string): UiRead => ({
      root: node(UiRole.WINDOW, 'Notes', {
        frame: [0, 0, 400, 300],
        children: [
          node(UiRole.BUTTON, 'Save', { frame: [10, 10, 80, 30] }),
          node(UiRole.GROUP, 'Tips', {
            frame: [10, 50, 200, 20],
            children: [node(UiRole.TEXT, tip, { frame: [10, 50, 200, 20] })],
          }),
          node(UiRole.TEXT, status, { frame: [10, 90, 200, 20] }),
        ],
      }),
      unread: 0,
      unmapped: [],
    });
    let now = shown('Tip 0', 'Ready');
    let after = now;
    const commands = new PeerCommands({
      driver: {
        subject: () => ({ app: 'Notes', pid: 7 }),
        read: () => Promise.resolve(now),
        reach: () => Promise.resolve({ reach: 'yes' }),
        act: () =>
          Promise.resolve({
            delivered: true,
            reachable: true,
            settled: true,
            before: now,
            after,
          }),
      },
      emit: () => undefined,
    });
    const press = async () => {
      const result = (await commands.answer(ReticleCommand.ACT, {
        ref: await refOf(commands, 'Save'),
        action: ActionType.CLICK,
      })) as { effect: Record<string, unknown> };
      now = after;
      return result.effect;
    };

    // Before the peer watched the application, it cannot know: the tip counts as an effect.
    after = shown('Tip 1', 'Ready');
    expect((await press())['domMutatedWithin']).toBe(2);

    // The peer looks while nothing acts. The first looks after an action teach nothing: a late
    // effect of the action can be in them. One change teaches nothing either.
    for (let tip = 2; tip < 8; tip += 1) {
      now = shown(`Tip ${String(tip)}`, 'Ready');
      await commands.sendTreeChanges();
    }

    // Only the tip changed during the action: no effect is claimed, and the answer says why.
    after = shown('Tip 8', 'Ready');
    const idle = await press();
    expect(idle['domMutatedWithin']).toBe(0);
    expect(idle['changedByItself']).toBe(2);

    // The real effect is still counted, next to the tip.
    after = shown('Tip 9', 'Saved');
    const real = await press();
    expect(real['domMutatedWithin']).toBe(2);
    expect(real['changedByItself']).toBe(2);
  });

  /**
   * A field in a web view answers "done" when its value is set from outside, and keeps its old
   * value. On the first real application, a fill was reported as delivered and the field was empty.
   */
  describe('a fill that the field did not take', () => {
    const form = (value: string): UiRead => ({
      root: node(UiRole.WINDOW, 'Todos', {
        frame: [0, 0, 400, 300],
        children: [node(UiRole.TEXTBOX, 'New todo', { frame: [10, 10, 200, 30], value })],
      }),
      unread: 0,
      unmapped: [],
    });
    const fillInto = async (start: string, takesKeys: boolean) => {
      let held = start;
      let selected = false;
      const kinds: string[] = [];
      const commands = new PeerCommands({
        driver: {
          subject: () => ({ app: 'Todos', pid: 7 }),
          read: () => Promise.resolve(form(held)),
          reach: () => Promise.resolve({ reach: 'yes' }),
          act: (request) => {
            kinds.push(request.kind);
            const before = form(held);
            if (takesKeys && ActKind.KEY === request.kind && 'Meta+a' === request.value) {
              selected = true;
            } else if (takesKeys && ActKind.TYPE === request.kind) {
              held = (selected ? '' : held) + (request.value ?? '');
              selected = false;
            }
            return Promise.resolve({
              delivered: true,
              reachable: true,
              settled: true,
              before,
              after: form(held),
            });
          },
        },
        emit: () => undefined,
      });
      const found = (await commands.answer(ReticleCommand.QUERY, { role: UiRole.TEXTBOX })) as {
        elements: { ref: string }[];
      };
      const answer = commands.answer(ReticleCommand.ACT, {
        ref: found.elements[0]?.ref ?? '',
        action: ActionType.FILL,
        args: { value: 'Buy milk' },
      }) as Promise<{ effect: Record<string, unknown> }>;
      return { answer, kinds, held: () => held };
    };

    it('types the value into an empty field, as a person does', async () => {
      const fill = await fillInto('', true);
      expect((await fill.answer).effect['valueChanged']).toBe(true);
      expect(fill.kinds).toEqual([ActKind.SET, ActKind.TYPE]);
      expect(fill.held()).toBe('Buy milk');
    });

    it('replaces other text: selects all of it, then types', async () => {
      const fill = await fillInto('Old', true);
      await fill.answer;
      expect(fill.kinds).toEqual([ActKind.SET, ActKind.KEY, ActKind.TYPE]);
      expect(fill.held()).toBe('Buy milk');
    });

    it('fails when the field takes no keys either', async () => {
      const fill = await fillInto('', false);
      await expect(fill.answer).rejects.toThrow(/holds ""/);
    });
  });

  /**
   * The place that changes by itself was the PARENT of what changed. A clock that lies in the
   * window, next to every control, then made the whole window such a place, and each real effect
   * was counted as "changed by itself".
   */
  describe('how wide a place that changes by itself is', () => {
    const acting = (shown: () => UiRead, next: () => UiRead) => {
      const commands = new PeerCommands({
        driver: {
          subject: () => ({ app: 'Notes', pid: 7 }),
          read: () => Promise.resolve(shown()),
          reach: () => Promise.resolve({ reach: 'yes' }),
          act: () =>
            Promise.resolve({
              delivered: true,
              reachable: true,
              settled: true,
              before: shown(),
              after: next(),
            }),
        },
        emit: () => undefined,
      });
      const press = async () =>
        (
          (await commands.answer(ReticleCommand.ACT, {
            ref: await refOf(commands, 'Save'),
            action: ActionType.CLICK,
          })) as { effect: Record<string, unknown> }
        ).effect;
      return { commands, press };
    };

    it('is one element, when one element changes: a real effect beside a clock is counted', async () => {
      const flat = (tick: number, status: string): UiRead => ({
        root: node(UiRole.WINDOW, 'Notes', {
          frame: [0, 0, 400, 300],
          children: [
            node(UiRole.BUTTON, 'Save', { frame: [10, 10, 80, 30] }),
            node(UiRole.TEXT, `Tick ${String(tick)}`, { frame: [10, 50, 200, 20] }),
            node(UiRole.TEXT, status, { frame: [10, 90, 200, 20] }),
          ],
        }),
        unread: 0,
        unmapped: [],
      });
      let now = flat(0, 'Ready');
      let after = now;
      const { commands, press } = acting(
        () => now,
        () => after,
      );
      for (let tick = 1; tick < 7; tick += 1) {
        now = flat(tick, 'Ready');
        await commands.sendTreeChanges();
      }
      after = flat(7, 'Saved');
      const effect = await press();
      expect(effect['domMutatedWithin']).toBe(2);
      expect(effect['changedByItself']).toBe(2);
    });

    it('is the whole list, when new rows come by themselves at new places', async () => {
      const chat = (rows: number): UiRead => ({
        root: node(UiRole.WINDOW, 'Notes', {
          frame: [0, 0, 400, 300],
          children: [
            node(UiRole.BUTTON, 'Save', { frame: [10, 10, 80, 30] }),
            node(UiRole.LIST, 'Messages', {
              frame: [10, 50, 300, 200],
              children: Array.from({ length: rows }, (_, row) =>
                node(UiRole.TEXT, `Message ${String(row)}`, {
                  frame: [10, 50 + 20 * row, 300, 20],
                }),
              ),
            }),
          ],
        }),
        unread: 0,
        unmapped: [],
      });
      let now = chat(0);
      let after = now;
      const { commands, press } = acting(
        () => now,
        () => after,
      );
      for (let rows = 1; rows < 8; rows += 1) {
        now = chat(rows);
        await commands.sendTreeChanges();
      }
      after = chat(8);
      const effect = await press();
      expect(effect['domMutatedWithin']).toBe(0);
      expect(effect['changedByItself']).toBe(1);
    });
  });

  // An application that ended in the middle of a press answered nothing to it. The peer said
  // that the operating system refused the press, and a caller then sent the press again.
  it('says that the application ended, not that the action was refused', async () => {
    const { commands } = peer({ delivered: false, appGone: true });
    await expect(
      commands.answer(ReticleCommand.ACT, {
        ref: await refOf(commands, 'Save'),
        action: ActionType.CLICK,
      }),
    ).rejects.toThrow(/Notes ended while the action on button "Save" ran/);
  });

  /**
   * `clear`, `check`, `uncheck` and `submit` are actions every agent sends to a form. The realm
   * refused each one by name, and a form with a checkbox could not be completed.
   */
  describe('the actions of a form', () => {
    const form = (value: string, checked: boolean): UiRead => ({
      root: node(UiRole.WINDOW, 'Sign up', {
        frame: [0, 0, 400, 300],
        children: [
          node(UiRole.TEXTBOX, 'Name', { frame: [10, 10, 200, 30], value }),
          node(UiRole.CHECKBOX, 'Remember', {
            frame: [10, 50, 200, 30],
            states: checked ? [ElementState.CHECKED] : [],
          }),
        ],
      }),
      unread: 0,
      unmapped: [],
    });
    const fake = (start: { value: string; checked: boolean }, pressWorks = true) => {
      const state = { ...start };
      const asked: [string, string | undefined][] = [];
      const commands = new PeerCommands({
        driver: {
          subject: () => ({ app: 'Sign up', pid: 7 }),
          read: () => Promise.resolve(form(state.value, state.checked)),
          reach: () => Promise.resolve({ reach: 'yes' }),
          act: (request) => {
            asked.push([request.kind, request.value]);
            const before = form(state.value, state.checked);
            if (ActKind.SET === request.kind) {
              state.value = request.value ?? '';
            }
            if (ActKind.PRESS === request.kind && pressWorks) {
              state.checked = !state.checked;
            }
            return Promise.resolve({
              delivered: true,
              reachable: true,
              settled: true,
              before,
              after: form(state.value, state.checked),
            });
          },
        },
        emit: () => undefined,
      });
      const act = async (role: UiRole, action: string) => {
        const found = (await commands.answer(ReticleCommand.QUERY, { role })) as {
          elements: { ref: string }[];
        };
        return (
          (await commands.answer(ReticleCommand.ACT, {
            ref: found.elements[0]?.ref ?? '',
            action,
          })) as { effect: Record<string, unknown> }
        ).effect;
      };
      return { act, asked, state };
    };

    it('clears a field', async () => {
      const { act, state } = fake({ value: 'Old', checked: false });
      expect((await act(UiRole.TEXTBOX, ActionType.CLEAR))['valueChanged']).toBe(true);
      expect(state.value).toBe('');
    });

    it('checks a box, and reads that it is checked', async () => {
      const { act, state } = fake({ value: '', checked: false });
      await act(UiRole.CHECKBOX, ActionType.CHECK);
      expect(state.checked).toBe(true);
    });

    it('sends nothing to a box that is in the state already, and says so', async () => {
      const { act, asked } = fake({ value: '', checked: true });
      const effect = await act(UiRole.CHECKBOX, ActionType.CHECK);
      expect(effect['alreadyAtValue']).toBe(true);
      expect(effect['dispatched']).toBe(false);
      expect(asked).toEqual([]);
    });

    it('fails when the box did not change', async () => {
      const { act } = fake({ value: '', checked: true }, false);
      await expect(act(UiRole.CHECKBOX, ActionType.UNCHECK)).rejects.toThrow(/is still checked/);
    });

    it('refuses to check an element that is not a box', async () => {
      const { act } = fake({ value: '', checked: false });
      await expect(act(UiRole.TEXTBOX, ActionType.CHECK)).rejects.toThrow(/checkbox/);
    });

    it('submits with the Return key in the field', async () => {
      const { act, asked } = fake({ value: 'Ada', checked: false });
      await act(UiRole.TEXTBOX, ActionType.SUBMIT);
      expect(asked).toEqual([[ActKind.KEY, 'Return']]);
    });
  });

  it('says why a press can have no effect, when the peer was told a reason', async () => {
    const still = { before: read('Ready'), after: read('Ready') };
    const press = async (commands: PeerCommands) =>
      (
        (await commands.answer(ReticleCommand.ACT, {
          ref: await refOf(commands, 'Save'),
          action: ActionType.CLICK,
        })) as { effect: Record<string, unknown> }
      ).effect;
    const driver: UiDriver = {
      ...fakeDriver(),
      act: () => Promise.resolve({ delivered: true, reachable: true, settled: true, ...still }),
    };
    const told = new PeerCommands({ driver, emit: () => undefined, noEffectNote: 'the switch' });
    expect((await press(told))['note']).toBe('the switch');
    // No reason was given: no note. And an action that did something has no note.
    expect((await press(new PeerCommands({ driver, emit: () => undefined })))['note']).toBe(
      undefined,
    );
    const acted = new PeerCommands({
      driver: {
        ...driver,
        act: () =>
          Promise.resolve({
            delivered: true,
            reachable: true,
            settled: true,
            before: read('Ready'),
            after: read('Saved'),
          }),
      },
      emit: () => undefined,
      noEffectNote: 'the switch',
    });
    expect((await press(acted))['note']).toBe(undefined);
  });

  // The menu bar of an application that is not in front is not on the screen. The operating
  // system then cannot say what is at that place, and the refusal was only "reach-unknown".
  it('says what to do when it cannot tell if a person can reach the element', async () => {
    const { commands } = peer({ refused: ActRefusal.REACH_UNKNOWN, detail: 'the hit test failed' });
    await expect(
      commands.answer(ReticleCommand.ACT, {
        ref: await refOf(commands, 'Save'),
        action: ActionType.CLICK,
      }),
    ).rejects.toThrow(/could not tell if a person can reach button "Save".*in front/s);
  });

  it('sends a signal when the action put something on the clipboard, with no content', async () => {
    const copied = peer({ clipboardChanged: true });
    await copied.commands.answer(ReticleCommand.ACT, {
      ref: await refOf(copied.commands, 'Save'),
      action: ActionType.CLICK,
    });
    expect(copied.events).toContainEqual([
      EventType.SIGNAL,
      { name: 'clipboard.changed', data: {} },
    ]);

    const not = peer({ clipboardChanged: false });
    await not.commands.answer(ReticleCommand.ACT, {
      ref: await refOf(not.commands, 'Save'),
      action: ActionType.CLICK,
    });
    expect(not.events.filter(([type]) => EventType.SIGNAL === type)).toEqual([]);
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
