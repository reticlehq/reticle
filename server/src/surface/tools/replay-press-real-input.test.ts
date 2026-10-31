/**
 * A replayed key press must reach the same keyboard as it did live.
 *
 * Live, `reticle_act` sends a document key (Tab, Escape) through the driven browser's real
 * keyboard. Replay sends its steps itself, and its keyboard wrapper stood aside whenever a
 * real-input provider existed, which is exactly `reticle verify`'s own browser, so a recorded Tab
 * replayed as a synthetic keydown that moves no focus.
 */
import { describe, expect, it } from 'vitest';
import { ActionType, ReticleCommand, type CommandResult } from '@reticlehq/core';
import { withLeaseKeyboard } from './real-input-attempt.js';
import type { Session } from '@/portal/session/session.js';
import type { ToolDeps } from './tool-kit.js';

const URL = 'http://localhost:3000/';

function fixture() {
  const performed: unknown[] = [];
  const toPage: unknown[] = [];
  const provider = {
    isAvailableFor: () => Promise.resolve(true),
    perform: (_url: string, action: string, _box: unknown, args: unknown) => {
      performed.push({ action, args });
      return Promise.resolve({ performed: true, inputMode: 'native' });
    },
  };
  const session = {
    id: 's1',
    url: URL,
    command: (name: string, args: Record<string, unknown>): Promise<CommandResult> => {
      toPage.push({ name, action: args['action'] });
      const result =
        ReticleCommand.INSPECT === name ? { states: ['focused'] } : { dispatched: true };
      return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
    },
  } as unknown as Session;
  const deps = { realInput: provider, sessions: { resolve: () => session } } as unknown as ToolDeps;
  return { deps, session, performed, toPage };
}

describe('a replayed press on a driven page', () => {
  it('goes to the real keyboard when a real-input provider drives the page', async () => {
    // A document key (no ref), as `reticle_act` sends it live. A key aimed at an element stays in
    // the page on both paths, by design: a real keyboard cannot aim a key at an element.
    const { deps, session, performed, toPage } = fixture();
    const wrapped = withLeaseKeyboard(deps, session);
    await wrapped.command(ReticleCommand.ACT, {
      action: ActionType.PRESS,
      ref: '',
      args: { key: 'Tab' },
    });
    expect(performed).toHaveLength(1);
    expect(toPage).toHaveLength(0);
  });

  it('still sends every other command to the page', async () => {
    const { deps, session, performed, toPage } = fixture();
    const wrapped = withLeaseKeyboard(deps, session);
    await wrapped.command(ReticleCommand.ACT, { action: ActionType.CLICK, ref: 'e1', args: {} });
    expect(performed).toHaveLength(0);
    expect(toPage).toHaveLength(1);
  });
});

/*
 * A recorded Enter in a text field, aimed at that field. Live, the lease keyboard focused the field
 * and pressed a real Enter, and the browser submitted the form. On `reticle verify`'s own page the
 * same step was refused the real keyboard ("a real key cannot aim at an element") and went in as
 * synthetic events, which submit nothing: the recorded journey failed on a working app.
 */
describe('a replayed press aimed at an element on a driven page', () => {
  it('focuses the element, then presses the real key', async () => {
    const { deps, session, performed, toPage } = fixture();
    const wrapped = withLeaseKeyboard(deps, session);
    const r = await wrapped.command(ReticleCommand.ACT, {
      action: ActionType.PRESS,
      ref: 'e1',
      args: { key: 'Enter' },
    });
    expect(toPage).toEqual([
      { name: ReticleCommand.ACT, action: ActionType.FOCUS },
      { name: ReticleCommand.INSPECT, action: undefined },
    ]);
    expect(performed).toHaveLength(1);
    expect(r.ok).toBe(true);
  });
});
