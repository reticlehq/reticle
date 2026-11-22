import {
  ActionType,
  ElementState,
  EventType,
  HumanControlKind,
  PresenterTone,
  ReticleCommand,
  SessionState,
  WindowArrangement,
  parseInteractive,
} from '@reticlehq/core';
import { describe, expect, it } from 'vitest';

import { ActKind, ActRefusal } from '../driver.js';
import type { ActOutcome, ActRequest, ReachAnswer, UiDriver, UiRead } from '../driver.js';
import { UiRole } from '../ui-node.js';
import type { UiNode } from '../ui-node.js';
import { HUMAN_DONE, PeerCommands } from './commands.js';

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
      commands.answer(ReticleCommand.ACT, { ref, action: ActionType.UPLOAD }),
    ).rejects.toThrow(/does not have the action upload/);
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

  // `{ key: 'Escape' }` came to the helper as no key at all, and the answer was "unknown-key":
  // nothing said that the key goes in `args.text`.
  it('says where the key goes when a press has none', async () => {
    const { commands, asked } = peer();
    const ref = await refOf(commands, 'Save');
    await expect(
      commands.answer(ReticleCommand.ACT, {
        ref,
        action: ActionType.PRESS,
        args: { key: 'Escape' },
      }),
    ).rejects.toThrow(/args\.text/);
    expect(asked).toEqual([]);
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

  // Granola rebuilds the groups round its Sidebar button when the sidebar closes. The button stays
  // where it was, with its name, and the ref of it was dead for the second press.
  it('follows a named control that stays at its place while the tree round it changes', async () => {
    const shell = (wrapped: boolean, dialog: string, okAt: number): UiRead => {
      const toggle = node(UiRole.BUTTON, 'Sidebar', { frame: [10, 10, 30, 30] });
      const ok = node(UiRole.DIALOG, dialog, {
        frame: [50, 150, 300, 120],
        children: [node(UiRole.BUTTON, 'OK', { frame: [okAt, 200, 60, 30] })],
      });
      return {
        root: node(UiRole.WINDOW, 'Granola', {
          frame: [0, 0, 400, 300],
          children: wrapped
            ? [node(UiRole.GROUP, '', { frame: [0, 0, 400, 50], children: [toggle] }), ok]
            : [toggle, ok],
        }),
        unread: 0,
        unmapped: [],
      };
    };
    let now = shell(false, 'Save?', 100);
    const pressed: string[] = [];
    const commands = new PeerCommands({
      driver: {
        subject: () => ({ app: 'Granola', pid: 7 }),
        read: () => Promise.resolve(now),
        reach: () => Promise.resolve(reachAnswer),
        act: (request) => {
          pressed.push(request.target.path.join('.'));
          return Promise.resolve({
            delivered: true,
            reachable: true,
            settled: true,
            before: now,
            after: now,
          });
        },
      },
      emit: () => undefined,
    });
    const toggle = await refOf(commands, 'Sidebar');
    const ok = await refOf(commands, 'OK');
    now = shell(true, 'Save?', 100);
    await commands.answer(ReticleCommand.ACT, { ref: toggle, action: ActionType.CLICK });
    // The button is the first child of the new group now.
    expect(pressed).toEqual(['0.0']);
    // The OK of another dialog, at another place, is another OK: the ref is refused.
    now = shell(true, 'Delete?', 250);
    await expect(
      commands.answer(ReticleCommand.ACT, { ref: ok, action: ActionType.CLICK }),
    ).rejects.toThrow(/no longer resolves/);
    expect(pressed).toEqual(['0.0']);
  });

  // A row is added above the rows an agent read. The ref of the Delete of "beta" must not press
  // the Delete of the row that is now in the place where "beta" was.
  it('does not press another row when a row comes above the row of a ref', async () => {
    const list = (rows: readonly string[]): UiRead => ({
      root: node(UiRole.WINDOW, 'Notes', {
        frame: [0, 0, 400, 300],
        children: rows.map((row, at) =>
          node(UiRole.GROUP, '', {
            frame: [0, 40 * at, 400, 40],
            children: [
              node(UiRole.TEXT, row, { frame: [10, 40 * at, 100, 30] }),
              node(UiRole.BUTTON, 'Delete', { frame: [200, 40 * at, 80, 30] }),
            ],
          }),
        ),
      }),
      unread: 0,
      unmapped: [],
    });
    let now = list(['alpha', 'beta']);
    const pressed: string[] = [];
    const commands = new PeerCommands({
      driver: {
        subject: () => ({ app: 'Notes', pid: 7 }),
        read: () => Promise.resolve(now),
        reach: () => Promise.resolve(reachAnswer),
        act: (request) => {
          const row = now.root.children[request.target.path[0] ?? -1]?.children[0]?.name ?? '';
          pressed.push(row);
          return Promise.resolve({
            delivered: true,
            reachable: true,
            settled: true,
            before: now,
            after: now,
          });
        },
      },
      emit: () => undefined,
    });
    const page = (await commands.answer(ReticleCommand.SNAPSHOT, {})) as { tree: string };
    const refs = [...page.tree.matchAll(/button "Delete" \(ref=(e\d+)\)/g)].map((m) => m[1]);
    const beta = refs[1];
    now = list(['new', 'alpha', 'beta']);
    await commands
      .answer(ReticleCommand.ACT, { ref: beta, action: ActionType.CLICK })
      .catch(() => undefined);
    // The Delete of "beta", or no press at all. Never the Delete of "alpha".
    expect(pressed.filter((row) => 'beta' !== row)).toEqual([]);
  });

  // Calculator: a group that holds the display and the keys, beside a toolbar, which is a group
  // with no name too. They are not two items of a list. When the key 7 changed the display, the
  // refs of every key went dead.
  it('keeps the refs of a group that is beside a group of another shape', async () => {
    const pad = (shown: string): UiRead => ({
      root: node(UiRole.WINDOW, 'Calculator', {
        frame: [0, 0, 300, 400],
        children: [
          node(UiRole.GROUP, '', {
            frame: [0, 0, 300, 360],
            children: [
              node(UiRole.TEXT, shown, { frame: [10, 10, 280, 40] }),
              node(UiRole.BUTTON, '7', { frame: [10, 60, 60, 60] }),
            ],
          }),
          node(UiRole.GROUP, '', {
            frame: [0, 360, 300, 40],
            children: [node(UiRole.BUTTON, 'Show Sidebar', { frame: [10, 365, 30, 30] })],
          }),
        ],
      }),
      unread: 0,
      unmapped: [],
    });
    let now = pad('0');
    const commands = new PeerCommands({
      driver: {
        subject: () => ({ app: 'Calculator', pid: 7 }),
        read: () => Promise.resolve(now),
        reach: () => Promise.resolve(reachAnswer),
        act: () => {
          const before = now;
          now = pad('7');
          return Promise.resolve({
            delivered: true,
            reachable: true,
            settled: true,
            before,
            after: now,
          });
        },
      },
      emit: () => undefined,
    });
    const seven = await refOf(commands, '7');
    await commands.answer(ReticleCommand.ACT, { ref: seven, action: ActionType.CLICK });
    // The display says 7 now. The same ref still names the key.
    await commands.answer(ReticleCommand.ACT, { ref: seven, action: ActionType.CLICK });
  });

  // Dictionary puts its search field in another group when it shows results. The fill had worked,
  // the realm said "did not resolve", and the ref was dead for the Return that came next.
  it('follows a field that the application moves in its tree when it takes the value', async () => {
    const window = (value: string, moved: boolean): UiRead => {
      const field = node(UiRole.TEXTBOX, '', { frame: [10, 10, 200, 20], value });
      const bar = node(UiRole.GROUP, '', { frame: [0, 0, 400, 40], children: [field] });
      const results = node(UiRole.GROUP, '', { frame: [0, 40, 400, 200] });
      return {
        root: node(UiRole.WINDOW, 'Dictionary', {
          frame: [0, 0, 400, 300],
          children: moved ? [bar, results] : [results, bar],
        }),
        unread: 0,
        unmapped: [],
      };
    };
    let now = window('', false);
    const asked: ActRequest[] = [];
    const commands = new PeerCommands({
      driver: {
        subject: () => ({ app: 'Dictionary', pid: 7 }),
        read: () => Promise.resolve(now),
        reach: () => Promise.resolve(reachAnswer),
        act: (request) => {
          asked.push(request);
          const before = now;
          if ('set' === request.kind) {
            now = window(request.value ?? '', true);
          }
          return Promise.resolve({
            delivered: true,
            reachable: true,
            settled: true,
            before,
            after: now,
          });
        },
      },
      emit: () => undefined,
    });
    const found = (await commands.answer(ReticleCommand.QUERY, { role: 'textbox' })) as {
      elements: { ref: string }[];
    };
    const ref = found.elements[0]?.ref;
    const filled = (await commands.answer(ReticleCommand.ACT, {
      ref,
      action: ActionType.FILL,
      args: { value: 'reticle' },
    })) as { effect: { valueChanged: boolean } };
    // The field went from one place to another, and its value is another one: that is a change
    // of value, and not only "one element went and one came".
    expect(filled.effect.valueChanged).toBe(true);
    // One set, and no keys after it: the value was read from the field where it is now.
    expect(asked.map((a) => a.kind)).toEqual(['set']);
    // The same ref still names the field.
    await commands.answer(ReticleCommand.ACT, { ref, action: ActionType.SUBMIT });
    expect(asked.at(-1)?.kind).toBe('key');
    expect(asked.at(-1)?.target.path.join('.')).toBe('0.0');
  });

  // Chrome gives a page with no scroll bar in its tree, and the scroll was refused there.
  it('scrolls with a key when the tree has no scroll bar, and says so', async () => {
    const page = (posts: number): UiRead => ({
      root: node(UiRole.WINDOW, 'Feed', {
        frame: [0, 0, 400, 300],
        children: [
          node(UiRole.DOCUMENT, 'Feed', {
            frame: [0, 0, 400, 300],
            children: Array.from({ length: posts }, (_, i) =>
              node(UiRole.TEXT, `Post ${String(i + 1)}`, { frame: [0, i * 20, 100, 20] }),
            ),
          }),
        ],
      }),
      unread: 0,
      unmapped: [],
    });
    const asked: ActRequest[] = [];
    const commands = new PeerCommands({
      driver: {
        subject: () => ({ app: 'Chrome', pid: 7 }),
        read: () => Promise.resolve(page(2)),
        reach: () => Promise.resolve(reachAnswer),
        act: (request) => {
          asked.push(request);
          return Promise.resolve({
            delivered: true,
            reachable: false,
            settled: true,
            before: page(2),
            after: page(3),
          });
        },
      },
      emit: () => undefined,
    });
    expect(await commands.answer(ReticleCommand.SCROLL, { fraction: 1 })).toEqual({
      scrolled: true,
      by: 'key',
      key: 'End',
    });
    expect(await commands.answer(ReticleCommand.SCROLL, { dy: -300 })).toMatchObject({
      key: 'PageUp',
    });
    // The page is the first child of the window.
    expect(asked.map((a) => [a.kind, a.value, a.target.path.join('.')])).toEqual([
      ['key', 'End', '0'],
      ['key', 'PageUp', '0'],
    ]);
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
    // Discord's list of servers moves with no bar and no key, as many lists of a web view do:
    // "Add a Server" stayed under the edge. With the foreground, the real wheel turns over the
    // element, as a person turns it.
    asked.length = 0;
    const wheeled = (await commands.answer(ReticleCommand.SCROLL, {
      ref: row,
      fraction: 1,
      foreground: true,
    })) as { by: string };
    expect(wheeled.by).toBe('wheel');
    expect(asked.map((a) => [a.kind, a.value, a.target.node.name])).toEqual([
      ['wheel', '40', 'Row 1'],
    ]);
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

  /**
   * A pop-up menu has its choices in a menu that is closed. A person presses the pop-up, reads
   * the choices and presses one. `select` was refused by name.
   */
  describe('select', () => {
    const popup = (open: boolean, chosen: string): UiRead => ({
      root: node(UiRole.WINDOW, 'Tasks', {
        frame: [0, 0, 400, 300],
        children: [
          node(UiRole.COMBOBOX, 'Priority', {
            frame: [10, 10, 120, 30],
            value: chosen,
            children: [
              node(UiRole.MENU, '', {
                frame: open ? [10, 40, 120, 60] : [10, 40, 0, 0],
                children: ['Low', 'High'].map((name, row) =>
                  node(UiRole.MENUITEM, name, {
                    frame: open ? [10, 40 + 20 * row, 120, 20] : [10, 40, 0, 0],
                  }),
                ),
              }),
            ],
          }),
        ],
      }),
      unread: 0,
      unmapped: [],
    });
    const fake = () => {
      const state = { open: false, chosen: 'Low' };
      const pressed: string[] = [];
      const commands = new PeerCommands({
        driver: {
          subject: () => ({ app: 'Tasks', pid: 7 }),
          read: () => Promise.resolve(popup(state.open, state.chosen)),
          reach: () => Promise.resolve({ reach: 'yes' }),
          act: (request) => {
            const before = popup(state.open, state.chosen);
            const name = request.target.node.name;
            pressed.push(ActKind.KEY === request.kind ? `key ${request.value ?? ''}` : name);
            if ('Priority' === name && ActKind.PRESS === request.kind) {
              state.open = true;
            } else if (ActKind.KEY === request.kind) {
              state.open = false;
            } else {
              state.chosen = name;
              state.open = false;
            }
            return Promise.resolve({
              delivered: true,
              reachable: true,
              settled: true,
              before,
              after: popup(state.open, state.chosen),
            });
          },
        },
        emit: () => undefined,
      });
      const select = async (value: string) => {
        const found = (await commands.answer(ReticleCommand.QUERY, { role: UiRole.COMBOBOX })) as {
          elements: { ref: string }[];
        };
        return commands.answer(ReticleCommand.ACT, {
          ref: found.elements[0]?.ref ?? '',
          action: ActionType.SELECT,
          args: { value },
        }) as Promise<{ effect: Record<string, unknown> }>;
      };
      return { select, pressed, state };
    };

    it('opens the pop-up and presses the choice', async () => {
      const { select, pressed, state } = fake();
      const answer = await select('High');
      expect(pressed).toEqual(['Priority', 'High']);
      expect(state.chosen).toBe('High');
      expect(answer.effect['domMutatedWithin']).toBeGreaterThan(0);
    });

    // A list in a web view gives no names for its choices: only the chosen one is there, with
    // no name. A person can still type the name of a choice into the list.
    it('types the name of the choice when the pop-up does not name its choices', async () => {
      const state = { value: 'Low' };
      const kinds: string[] = [];
      const web = (): UiRead => ({
        root: node(UiRole.WINDOW, 'Tasks', {
          frame: [0, 0, 400, 300],
          children: [
            node(UiRole.COMBOBOX, 'Priority', { frame: [10, 10, 120, 30], value: state.value }),
          ],
        }),
        unread: 0,
        unmapped: [],
      });
      const commands = new PeerCommands({
        driver: {
          subject: () => ({ app: 'Tasks', pid: 7 }),
          read: () => Promise.resolve(web()),
          reach: () => Promise.resolve({ reach: 'yes' }),
          act: (request) => {
            const before = web();
            kinds.push(request.kind);
            if (ActKind.TYPE === request.kind && 'High' === request.value) {
              state.value = 'High';
            }
            return Promise.resolve({
              delivered: true,
              reachable: true,
              settled: true,
              before,
              after: web(),
            });
          },
        },
        emit: () => undefined,
      });
      const ref = (
        (await commands.answer(ReticleCommand.QUERY, { role: UiRole.COMBOBOX })) as {
          elements: { ref: string }[];
        }
      ).elements[0]?.ref;
      const select = (value: string) =>
        commands.answer(ReticleCommand.ACT, { ref, action: ActionType.SELECT, args: { value } });
      await select('High');
      expect(state.value).toBe('High');
      // The pop-up is not opened: only the keys are sent.
      expect(kinds).toEqual([ActKind.TYPE]);
      await expect(select('Urgent')).rejects.toThrow(/did not go to the choice "Urgent"/);
    });

    it('closes the pop-up and names the choices when the one asked for is not there', async () => {
      const { select, pressed, state } = fake();
      await expect(select('Urgent')).rejects.toThrow(/no choice "Urgent".*"Low", "High"/s);
      expect(pressed).toEqual(['Priority', 'key Escape']);
      expect(state.open).toBe(false);
    });
  });

  /**
   * Two buttons with one role and one name: a replay cannot tell which one the recording meant,
   * and it refuses. The server anchors a step on a test id when the answer to the action has
   * one. The identifier of the element is that id.
   */
  describe('the identifier of an element', () => {
    const rows = (): UiRead => ({
      root: node(UiRole.WINDOW, 'Notes', {
        frame: [0, 0, 400, 300],
        children: ['alpha', 'beta', 'beta'].map((id, row) =>
          node(UiRole.BUTTON, 'Delete', { frame: [10, 10 + 40 * row, 80, 30], id: `delete-${id}` }),
        ),
      }),
      unread: 0,
      unmapped: [],
    });
    const commands = () =>
      new PeerCommands({
        driver: {
          subject: () => ({ app: 'Notes', pid: 7 }),
          read: () => Promise.resolve(rows()),
          reach: () => Promise.resolve({ reach: 'yes' }),
          act: () =>
            Promise.resolve({
              delivered: true,
              reachable: true,
              settled: true,
              before: rows(),
              after: rows(),
            }),
        },
        emit: () => undefined,
      });
    const find = (peer: PeerCommands, query: Record<string, unknown>) =>
      peer.answer(ReticleCommand.QUERY, query) as Promise<{
        elements: { ref: string; testid?: string }[];
      }>;

    it('finds one element of several with the same name', async () => {
      const found = await find(commands(), { by: 'testid', value: 'delete-alpha' });
      expect(found.elements).toHaveLength(1);
      expect(found.elements[0]?.testid).toBe('delete-alpha');
    });

    it('is in the answer to an action, with how many elements share it', async () => {
      const peer = commands();
      const act = async (index: number) => {
        const all = await find(peer, { role: UiRole.BUTTON });
        return peer.answer(ReticleCommand.ACT, {
          ref: all.elements[index]?.ref ?? '',
          action: ActionType.CLICK,
        }) as Promise<Record<string, unknown>>;
      };
      const one = await act(0);
      expect(one['testid']).toBe('delete-alpha');
      expect(one['testidOf']).toBeUndefined();
      const shared = await act(2);
      expect(shared['testid']).toBe('delete-beta');
      expect(shared['testidOf']).toBe(2);
      expect(shared['testidNth']).toBe(1);
    });
  });

  // A person rests the pointer on a button to read what it does. The realm has no hover. The
  // tooltip is in the tree, so the answer to `inspect` gives its words.
  it('gives the tooltip of an element when it is inspected', async () => {
    const tipped: UiRead = {
      root: node(UiRole.WINDOW, 'Notes', {
        frame: [0, 0, 400, 300],
        children: [
          node(UiRole.BUTTON, 'Save', { frame: [10, 10, 80, 30], help: 'Saves the title' }),
          node(UiRole.BUTTON, 'Dead', { frame: [100, 10, 80, 30] }),
        ],
      }),
      unread: 0,
      unmapped: [],
    };
    const commands = new PeerCommands({
      driver: { ...fakeDriver(), read: () => Promise.resolve(tipped) },
      emit: () => undefined,
    });
    const inspect = async (name: string) =>
      (await commands.answer(ReticleCommand.INSPECT, { ref: await refOf(commands, name) })) as {
        help?: string;
      };
    expect((await inspect('Save')).help).toBe('Saves the title');
    expect((await inspect('Dead')).help).toBeUndefined();
  });

  /**
   * A double-click, a hover, a drag and a right-click need the real pointer. The realm refused
   * each of them by name. It now does them when the caller asks for the foreground, which takes
   * the pointer of the person at the machine, and it says how to ask.
   */
  describe('the real pointer', () => {
    const acting = (foreground?: boolean) => {
      const made = peer();
      const commands =
        foreground === undefined
          ? made.commands
          : new PeerCommands({
              driver: {
                ...fakeDriver(),
                act: (request) => {
                  made.asked.push(request);
                  return Promise.resolve({
                    delivered: true,
                    reachable: true,
                    settled: true,
                    before: read('Ready'),
                    after: read('Saved'),
                  });
                },
              },
              emit: () => undefined,
              foreground,
            });
      const act = async (action: string, args?: Record<string, unknown>) =>
        commands.answer(ReticleCommand.ACT, {
          ref: await refOf(commands, 'Save'),
          action,
          ...(args === undefined ? {} : { args }),
        });
      return { act, asked: made.asked, commands };
    };

    it('is not used unless the caller asks, and the refusal says how to ask', async () => {
      const { act, asked } = acting();
      for (const action of [ActionType.DBLCLICK, ActionType.HOVER, ActionType.FOCUS]) {
        await expect(act(action)).rejects.toThrow(/args: \{ foreground: true \}/);
      }
      expect(asked).toEqual([]);
    });

    it('is used when the caller asks: a double-click, a hover, a click', async () => {
      const { act, asked } = acting();
      await act(ActionType.DBLCLICK, { foreground: true });
      await act(ActionType.HOVER, { foreground: true });
      await act(ActionType.CLICK, { foreground: true });
      expect(asked.map((request) => [request.kind, request.delivery])).toEqual([
        [ActKind.DBLCLICK, 'foreground'],
        [ActKind.HOVER, 'foreground'],
        [ActKind.CLICK, 'foreground'],
      ]);
    });

    it('gives the menu of a right-click by name, and uses the real button in the foreground', async () => {
      const { act, asked } = acting();
      await act(ActionType.CLICK, { button: 'right' });
      await act(ActionType.CLICK, { button: 'right', foreground: true });
      expect(asked.map((request) => [request.kind, request.delivery])).toEqual([
        [ActKind.MENU, 'user-path'],
        [ActKind.RIGHTCLICK, 'foreground'],
      ]);
    });

    it('drags to the middle of another element, or to a point', async () => {
      const { act, asked, commands } = acting();
      await act(ActionType.DRAG, {
        foreground: true,
        to: { ref: await refOf(commands, 'Delete note') },
      });
      await act(ActionType.DRAG, { foreground: true, to: { x: 5, y: 6 } });
      expect(asked.map((request) => request.value)).toEqual(['140,25', '5,6']);
      await expect(act(ActionType.DRAG, { foreground: true })).rejects.toThrow(/where to drag to/);
    });

    it('is never used in a session that was joined for the background only', async () => {
      const { act, asked } = acting(false);
      await expect(act(ActionType.CLICK, { foreground: true })).rejects.toThrow(/background-only/);
      expect(asked).toEqual([]);
    });
  });

  /**
   * An application that draws its own window gives no elements: a canvas, a game. The realm
   * read nothing of it. It now takes a picture of the window, and a caller can click at a point
   * of that picture.
   */
  describe('a picture of the window', () => {
    const picturing = (taken: unknown) => {
      const made = peer();
      const moves: [number, number][] = [];
      const commands = new PeerCommands({
        driver: {
          ...fakeDriver(),
          ...(taken === undefined ? {} : { capture: () => Promise.resolve(taken as never) }),
          act: (request) => {
            made.asked.push(request);
            return Promise.resolve({
              delivered: true,
              reachable: true,
              settled: true,
              before: read('Ready'),
              after: read('Saved'),
            });
          },
        },
        emit: () => undefined,
        hud: {
          app: () => undefined,
          move: (x, y) => moves.push([x, y]),
          glow: () => undefined,
          act: () => undefined,
          effect: () => undefined,
          paused: () => false,
          stopped: () => false,
          close: () => undefined,
        },
      });
      const clickAt = async (args: Record<string, unknown>) =>
        commands.answer(ReticleCommand.ACT, {
          ref: await refOf(commands, 'Save'),
          action: ActionType.CLICK,
          args,
        });
      return { commands, clickAt, asked: made.asked, moves };
    };
    const shot = {
      ok: true,
      path: '/tmp/reticle-capture-1.png',
      // Where the window of the test is. A picture of a window at another place is old.
      window: [0, 0, 400, 300],
      scale: 2,
    };

    it('gives the file of the picture, in the shape the server reads', async () => {
      const { commands } = picturing(shot);
      expect(await commands.answer(ReticleCommand.CAPTURE, {})).toEqual({
        ok: true,
        path: '/tmp/reticle-capture-1.png',
      });
    });

    // A whole-screen picture shows every application: an overlay of another one, a dialog of the
    // system. Its pixels start at the corner of the display, not of the window.
    it('takes the whole screen when asked, and a point of it is a point of the screen', async () => {
      const asked: unknown[] = [];
      const made = picturing(undefined);
      const commands = new PeerCommands({
        driver: {
          ...fakeDriver(),
          capture: (how) => {
            asked.push(how);
            return Promise.resolve({
              ok: true,
              path: '/tmp/reticle-capture-2.png',
              window: [0, 0, 1000, 800],
              scale: 2,
              appWindow: [0, 0, 400, 300],
            } as never);
          },
          act: (request) => {
            made.asked.push(request);
            return Promise.resolve({
              delivered: true,
              reachable: true,
              settled: true,
              before: read('Ready'),
              after: read('Saved'),
            });
          },
        },
        emit: () => undefined,
      });
      expect(await commands.answer(ReticleCommand.CAPTURE, { screen: true })).toEqual({
        ok: true,
        path: '/tmp/reticle-capture-2.png',
        screen: true,
      });
      expect(asked).toEqual([{ screen: true }]);
      // The window did not move: the click is not refused, and the point maps from the display.
      await commands.answer(ReticleCommand.ACT, {
        ref: await refOf(commands, 'Save'),
        action: ActionType.CLICK,
        args: { foreground: true, at: { x: 600, y: 400 } },
      });
      expect(made.asked.at(-1)?.value).toBe('300,200');
    });

    it('says what to do when the terminal may not record the screen', async () => {
      const { commands } = picturing({ ok: false, reason: 'no-screen-recording-permission' });
      const answer = (await commands.answer(ReticleCommand.CAPTURE, {})) as { reason: string };
      expect(answer.reason).toContain('Screen Recording');
    });

    it('clicks at a point of the picture: its pixels become a point on the screen', async () => {
      const { commands, clickAt, asked } = picturing(shot);
      await commands.answer(ReticleCommand.CAPTURE, {});
      await clickAt({ foreground: true, at: { x: 200, y: 100 } });
      // The window is at 0,0 and the picture has two pixels for each point.
      expect(asked.map((request) => [request.kind, request.value])).toEqual([
        [ActKind.CLICK, '100,50'],
      ]);
    });

    // The pointer of the HUD went to the middle of the element, and for a point of a picture the
    // element is the whole window: the person saw the pointer stay still at each click.
    it('moves the pointer of the HUD to the point that it clicks, not to the middle of the element', async () => {
      const { commands, clickAt, moves } = picturing(shot);
      await commands.answer(ReticleCommand.CAPTURE, {});
      await clickAt({ foreground: true, at: { x: 200, y: 100 } });
      expect(moves.at(-1)).toEqual([100, 50]);
    });

    // A point of a picture is a place in the window as it was. When the window moved or changed
    // its size after the picture, the click lands on something else, and the log says "click".
    it('refuses a point of a picture of a window that moved after the picture', async () => {
      const { commands, clickAt, asked } = picturing({ ...shot, window: [100, 50, 400, 300] });
      await commands.answer(ReticleCommand.CAPTURE, {});
      await expect(clickAt({ foreground: true, at: { x: 200, y: 100 } })).rejects.toThrow(
        /moved or changed its size.*reticle_screenshot/s,
      );
      expect(asked).toEqual([]);
    });

    // The window stays, and its content scrolls under the point: the point is then on another row.
    // A value that changes in its place, as a clock, does not move the content.
    it('refuses a point of a picture when the content moved under it, and not for a clock', async () => {
      const rows = (top: number, clock: string): UiRead => ({
        root: node(UiRole.WINDOW, 'Notes', {
          frame: [0, 0, 400, 300],
          children: [
            node(UiRole.BUTTON, 'Save', { frame: [10, 10, 80, 30] }),
            node(UiRole.TEXT, clock, { frame: [300, 10, 80, 20] }),
            node(UiRole.TEXT, 'Row', { frame: [10, top, 200, 20] }),
          ],
        }),
        unread: 0,
        unmapped: [],
      });
      let now = rows(100, '1:00');
      const asked: ActRequest[] = [];
      const commands = new PeerCommands({
        driver: {
          ...fakeDriver(),
          read: () => Promise.resolve(now),
          capture: () => Promise.resolve(shot as never),
          act: (request) => {
            asked.push(request);
            return Promise.resolve({
              delivered: true,
              reachable: true,
              settled: true,
              before: now,
              after: now,
            });
          },
        },
        emit: () => undefined,
      });
      const click = async () =>
        commands.answer(ReticleCommand.ACT, {
          ref: await refOf(commands, 'Save'),
          action: ActionType.CLICK,
          args: { foreground: true, at: { x: 20, y: 220 } },
        });
      await commands.answer(ReticleCommand.CAPTURE, {});
      now = rows(100, '1:01');
      await click();
      expect(asked).toHaveLength(1);
      now = rows(60, '1:01');
      await expect(click()).rejects.toThrow(
        /content of the window of Notes moved.*reticle_screenshot/s,
      );
      expect(asked).toHaveLength(1);
    });

    it('refuses a point with no picture, and a point with no foreground', async () => {
      const none = picturing(shot);
      await expect(none.clickAt({ foreground: true, at: { x: 1, y: 1 } })).rejects.toThrow(
        /no picture was taken/,
      );
      await none.commands.answer(ReticleCommand.CAPTURE, {});
      await expect(none.clickAt({ at: { x: 1, y: 1 } })).rejects.toThrow(/foreground: true/);
      expect(none.asked).toEqual([]);
    });
  });

  /**
   * The realm acts in the background, so nothing on the screen said where it was or what it did.
   * The person at the machine now sees a pointer of the realm's own and a small window, and can
   * pause the realm there.
   */
  describe('what the person at the machine sees', () => {
    const watched = (isPaused = false, isStopped = false) => {
      const shown: unknown[][] = [];
      const made = peer();
      const commands = new PeerCommands({
        driver: {
          ...fakeDriver(),
          act: (request) => {
            made.asked.push(request);
            return Promise.resolve({
              delivered: true,
              reachable: true,
              settled: true,
              before: read('Ready'),
              after: read('Saved'),
            });
          },
        },
        emit: () => undefined,
        hud: {
          app: (name) => shown.push(['app', name]),
          move: (x, y) => shown.push(['move', x, y]),
          glow: (frame) => shown.push(['glow', ...frame]),
          act: (text) => shown.push(['act', text]),
          effect: (text, kind) => shown.push(['effect', text, kind]),
          paused: () => isPaused,
          stopped: () => isStopped,
          close: () => undefined,
        },
      });
      const press = async () =>
        commands.answer(ReticleCommand.ACT, {
          ref: await refOf(commands, 'Save'),
          action: ActionType.CLICK,
        });
      return { press, shown, asked: made.asked };
    };

    // A long task stops for the person: a 2FA code, a captcha. `yield` with mode "ask" sends the
    // question as a PRESENTER post, and the realm answered "does not answer presenter": the person
    // saw nothing. Now the HUD shows it, and "Done" on the HUD goes back as the person's message.
    it('shows the turn of the person, and their Done goes back to the agent', async () => {
      const turns: unknown[] = [];
      const said: unknown[] = [];
      let done: (() => void) | undefined;
      const commands = new PeerCommands({
        driver: fakeDriver(),
        emit: (type, data) => said.push([type, data]),
        hud: {
          app: () => undefined,
          move: () => undefined,
          glow: () => undefined,
          act: () => undefined,
          effect: () => undefined,
          paused: () => false,
          stopped: () => false,
          close: () => undefined,
          turn: (turn) => turns.push(turn),
          onDone: (listener) => {
            done = listener;
          },
        },
      });
      await commands.answer(ReticleCommand.PRESENTER, {
        state: SessionState.ENDED,
        tone: PresenterTone.ASK,
        text: 'Type the 2FA code in Discord',
      });
      expect(turns).toEqual([
        {
          state: SessionState.ENDED,
          tone: PresenterTone.ASK,
          text: 'Type the 2FA code in Discord',
        },
      ]);
      done?.();
      expect(said).toContainEqual([
        EventType.HUMAN_CONTROL,
        { kind: HumanControlKind.MESSAGE, text: HUMAN_DONE },
      ]);
    });

    it('is told the application, where the realm acts, what it does and what that did', async () => {
      const { press, shown } = watched();
      await press();
      expect(shown).toEqual([
        ['app', 'Notes'],
        // The middle of the Save button.
        ['move', 50, 25],
        // The window the button is in.
        ['glow', 0, 0, 400, 300],
        ['act', 'press button "Save"'],
        ['effect', '2 change(s)', 'ok'],
      ]);
    });

    it('does no action after Stop, and the caller is told why', async () => {
      const { press, asked } = watched(false, true);
      await expect(press()).rejects.toThrow(/stopped Reticle/);
      expect(asked).toEqual([]);
    });

    it('stops the realm with Pause: no action is done, and the caller is told why', async () => {
      const { press, asked } = watched(true);
      await expect(press()).rejects.toThrow(/paused Reticle/);
      expect(asked).toEqual([]);
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
    // No reason was given: the note says that nothing was seen, so that "dispatched" is not read
    // as "done". Chrome answered "done" to a press that its page never got.
    expect(
      String((await press(new PeerCommands({ driver, emit: () => undefined })))['note']),
    ).toContain('nothing changed');
    // A press that wrote to disk did something, with nothing on the screen: no note.
    const wrote = new PeerCommands({
      driver: {
        ...driver,
        act: () =>
          Promise.resolve({
            delivered: true,
            reachable: true,
            settled: true,
            ...still,
            bytesWritten: 12,
          }),
      },
      emit: () => undefined,
    });
    expect((await press(wrote))['note']).toBe(undefined);
    // An action that did something on the screen has no note.
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

// A person arranges windows: puts two side by side, makes one small, fills the screen. The realm
// had no action for it, so two tabs of Dia could not be put next to each other.
describe('window', () => {
  const moved = (frame: [number, number, number, number]): UiRead => {
    const before = read('Ready');
    return { ...before, root: { ...before.root, frame } };
  };

  it('arranges the window of the element, and answers with its frame after the change', async () => {
    const { commands, asked } = peer({
      after: moved([0, 25, 756, 900]),
      windowState: {
        minimized: false,
        fullscreen: false,
        frame: [0, 25, 756, 900],
        wanted: [0, 25, 756, 900],
      },
    });
    const answer = (await commands.answer(ReticleCommand.ACT, {
      ref: await refOf(commands, 'Save'),
      action: ActionType.WINDOW,
      args: { arrange: WindowArrangement.LEFT },
    })) as { window?: unknown };
    expect(asked.map((request) => [request.kind, request.value])).toEqual([
      [ActKind.WINDOW, WindowArrangement.LEFT],
    ]);
    expect(answer.window).toEqual({
      x: 0,
      y: 25,
      width: 756,
      height: 900,
      minimized: false,
      fullscreen: false,
    });
  });

  // A minimized window keeps its frame in the Accessibility API: the frame alone said nothing.
  it('says that the window is minimized, from what the helper read of it after', async () => {
    const { commands } = peer({
      windowState: { minimized: true, fullscreen: false, frame: [0, 25, 400, 300] },
    });
    const answer = (await commands.answer(ReticleCommand.ACT, {
      ref: await refOf(commands, 'Save'),
      action: ActionType.WINDOW,
      args: { arrange: WindowArrangement.MINIMIZE },
    })) as { window?: { minimized: boolean } };
    expect(answer.window?.minimized).toBe(true);
  });

  it('gives the window an exact frame', async () => {
    const { commands, asked } = peer({
      windowState: {
        minimized: false,
        fullscreen: false,
        frame: [100, 50, 800, 600],
        wanted: [100, 50, 800, 600],
      },
    });
    await commands.answer(ReticleCommand.ACT, {
      ref: await refOf(commands, 'Save'),
      action: ActionType.WINDOW,
      args: { frame: { x: 100, y: 50, width: 800, height: 600 } },
    });
    expect(asked.at(-1)?.value).toBe('frame:100,50,800,600');
  });

  // The system says yes to a set that it does not do: an application with no tile in the Dock
  // keeps its window on the screen, and the realm answered ok.
  it('fails when the window is not as asked after the change, and says what it is', async () => {
    const minimize = peer({ windowState: { minimized: false, fullscreen: false } });
    await expect(
      minimize.commands.answer(ReticleCommand.ACT, {
        ref: await refOf(minimize.commands, 'Save'),
        action: ActionType.WINDOW,
        args: { arrange: WindowArrangement.MINIMIZE },
      }),
    ).rejects.toThrow(/did not go to the Dock/);
    const half = peer({
      windowState: {
        minimized: false,
        fullscreen: false,
        frame: [0, 25, 900, 900],
        wanted: [0, 25, 756, 900],
      },
    });
    await expect(
      half.commands.answer(ReticleCommand.ACT, {
        ref: await refOf(half.commands, 'Save'),
        action: ActionType.WINDOW,
        args: { arrange: WindowArrangement.LEFT },
      }),
    ).rejects.toThrow(/did not take the frame 0,25,756,900: it is 0,25,900,900/);
  });

  it('refuses an arrangement it does not know, and names the ones it knows', async () => {
    const { commands, asked } = peer();
    await expect(
      commands.answer(ReticleCommand.ACT, {
        ref: await refOf(commands, 'Save'),
        action: ActionType.WINDOW,
        args: { arrange: 'sideways' },
      }),
    ).rejects.toThrow(/minimize, zoom, fullscreen, restore, left, right.*frame/);
    expect(asked).toEqual([]);
  });
});
