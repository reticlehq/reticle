import {
  ActionType,
  ElementState,
  EventType,
  ReticleCommand,
  parseInteractive,
} from '@reticlehq/core';
import { describe, expect, it } from 'vitest';

import { ActRefusal } from '../driver.js';
import type { ActOutcome, ActRequest, UiDriver, UiRead } from '../driver.js';
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
      node(UiRole.TEXT, status, { frame: [10, 90, 200, 20] }),
    ],
  });
  return { root, unread: 0, unmapped: [] };
}

function peer(outcome: Partial<ActOutcome> = {}) {
  const asked: ActRequest[] = [];
  const events: [string, Record<string, unknown>][] = [];
  const driver: UiDriver = {
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
    expect(snapshot.nodes).toBe(6);
    expect(snapshot.truncated).toBe(false);
    expect(parseInteractive(snapshot.tree)).toHaveLength(6);
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
    const looks = [new Map(), new Map([['/out/note.txt', fact]])];
    const events: [string, Record<string, unknown>][] = [];
    const commands = new PeerCommands({
      driver: {
        subject: () => ({ app: 'Notes', pid: 7 }),
        read: () => Promise.resolve(read('Ready')),
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
  });
});
