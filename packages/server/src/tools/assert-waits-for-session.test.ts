/**
 * The wiring half of the inert-`timeout_ms` defect.
 *
 * `session-wait.test.ts` pins what the wait DOES. This pins that the tools reach it at all: each
 * handler resolved a session as its first statement, so the no-session error was raised before the
 * timeout argument had been read. The bug was the ORDER of two lines, and only a test that drives
 * the tool can see the order — a helper can be perfect and still be called too late.
 *
 * The manager here refuses once, the way a daemon does while an app is still reconnecting, then
 * answers. A handler that resolves before reading `timeout_ms` fails on the first refusal.
 */
import { describe, it, expect } from 'vitest';
import { LastAct } from '../session/last-act.js';
import { PredicateKind, ReticleCommand, SessionState, type CommandResult } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { NoSessionConnectedError } from '../session/session-manager.js';
import type { Session, SessionManager } from '../session/session.js';

/** Deps whose `resolve` refuses `refusals` times before the app reconnects. */
function depsConnectingAfter(refusals: number): ToolDeps {
  const stub: Partial<Session> = {
    id: 'demo',
    command: (name: string): Promise<CommandResult> =>
      Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result:
          name === ReticleCommand.MATCH
            ? {
                matched: true,
                count: 1,
                elements: [{ ref: 'e1', role: 'button', name: 'X', states: [], visible: true }],
              }
            : {},
      }),
    eventsSince: () => [],
    // The waiting path subscribes; the predicate here is already true, so it never fires.
    onEvent: () => () => undefined,
    throttled: () => false,
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    bufferHealth: () => ({ total: 0, dropped: 0 }),
    recordAction: () => 'a1',
    lastAct: new LastAct(),
    queryEvents: () => Promise.resolve([]),
    blindSpots: () => ({}),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
  };
  let calls = 0;
  const sessions: Partial<SessionManager> = {
    resolve: () => {
      calls += 1;
      if (calls <= refusals) throw new NoSessionConnectedError('nothing is connected');
      return stub as Session;
    },
  };
  return { sessions: sessions as SessionManager } as ToolDeps;
}

function toolNamed(name: string) {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no ${name} tool`);
  return tool;
}

const PRESENT = { kind: PredicateKind.ELEMENT, query: { role: 'button', name: 'X' } };

describe('a tool given timeout_ms waits for the app to reconnect', () => {
  it('reticle_assert reaches a verdict instead of refusing at t=0', async () => {
    const deps = depsConnectingAfter(2);

    const out = (await toolNamed(ReticleTool.ASSERT).handler(deps, {
      predicate: PRESENT,
      timeout_ms: 5_000,
    })) as Record<string, unknown>;

    expect(out['verified']).toBeDefined();
  });

  it('reticle_wait_for reaches a verdict instead of refusing at t=0', async () => {
    const deps = depsConnectingAfter(2);

    const out = (await toolNamed(ReticleTool.WAIT_FOR).handler(deps, {
      predicate: PRESENT,
      timeout_ms: 5_000,
    })) as Record<string, unknown>;

    // wait_for answers with the raw verdict rather than assert's `verified` wording.
    expect(out['pass']).toBe(true);
  });

  it('reticle_assert with timeout_ms 0 still refuses at once', async () => {
    // The documented no-wait mode: evaluate now. It must not start waiting just because a wait
    // became possible -- that would turn an instant answer into a hang on a genuinely dead app.
    const deps = depsConnectingAfter(1);

    await expect(
      toolNamed(ReticleTool.ASSERT).handler(deps, { predicate: PRESENT, timeout_ms: 0 }),
    ).rejects.toThrow('nothing is connected');
  });
});
