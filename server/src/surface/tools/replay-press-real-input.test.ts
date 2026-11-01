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
  const toPage: { name: string; action?: unknown; count?: number | undefined }[] = [];
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
      toPage.push({
        name,
        action: args['action'],
        count: Array.isArray(args['steps']) ? args['steps'].length : undefined,
      });
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

/*
 * The same Enter, recorded as one sub-step of a sequence (fill the field, press Enter, then check).
 * Replay sent the whole sequence to the page as one command, so the press stayed synthetic and the
 * form was never submitted: measured, every "fill, press Enter" sequence failed on the correct
 * app. The page still runs the other sub-steps together; each press gets the real keyboard.
 */
describe('a replayed sequence with a press in it', () => {
  it('runs the other sub-steps in the page and the press on the real keyboard, in order', async () => {
    const { deps, session, performed, toPage } = fixture();
    const wrapped = withLeaseKeyboard(deps, session);
    const r = await wrapped.command(ReticleCommand.ACT_SEQUENCE, {
      steps: [
        { ref: 'e1', action: ActionType.FILL, args: { value: 'x' } },
        { ref: 'e1', action: ActionType.PRESS, args: { key: 'Enter' } },
        { ref: 'e2', action: ActionType.CLICK, args: {} },
      ],
    });
    expect(r.ok).toBe(true);
    expect(
      toPage.map((c) => `${c.name}:${String(c.count ?? (c.action as string | undefined))}`),
    ).toEqual([
      `${ReticleCommand.ACT_SEQUENCE}:1`,
      `${ReticleCommand.ACT}:${ActionType.FOCUS}`,
      `${ReticleCommand.INSPECT}:undefined`,
      `${ReticleCommand.ACT_SEQUENCE}:1`,
    ]);
    expect(performed).toHaveLength(1);
  });

  it('sends a sequence with no press to the page unchanged', async () => {
    const { deps, session, performed, toPage } = fixture();
    const wrapped = withLeaseKeyboard(deps, session);
    await wrapped.command(ReticleCommand.ACT_SEQUENCE, {
      steps: [
        { ref: 'e1', action: ActionType.FILL, args: { value: 'x' } },
        { ref: 'e2', action: ActionType.CLICK, args: {} },
      ],
    });
    expect(toPage.map((c) => `${c.name}:${String(c.count)}`)).toEqual([
      `${ReticleCommand.ACT_SEQUENCE}:2`,
    ]);
    expect(performed).toHaveLength(0);
  });
});

/*
 * A press after a page load inside one recorded sequence. The click before it loaded a new page, so
 * the press's ref (found before the sequence ran) no longer resolved. Focusing it threw, and the throw
 * stopped the whole replay before the stale-ref retry could find the press again on the new page:
 * an upload journey was `unknown` on a working app.
 */
describe('a press with a stale ref inside a replayed sequence', () => {
  it('answers a failed result that names the stale ref, so the retry can find the press again', async () => {
    const { deps, session } = fixture();
    const stale = "ref 'e151' no longer resolves to an element";
    const command = session.command.bind(session);
    (session as { command: Session['command'] }).command = (name, args = {}, timeoutMs) =>
      ReticleCommand.ACT === name && ActionType.FOCUS === args['action']
        ? Promise.resolve({ kind: 'command_result', id: 'f', ok: false, error: stale })
        : command(name, args, timeoutMs);
    const wrapped = withLeaseKeyboard(deps, session);
    const r = await wrapped.command(ReticleCommand.ACT_SEQUENCE, {
      steps: [{ ref: 'e151', action: ActionType.PRESS, args: { key: 'Enter' } }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(stale);
  });
});
