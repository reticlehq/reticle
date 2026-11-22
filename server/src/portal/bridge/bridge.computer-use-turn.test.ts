import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOOPBACK_HOST, PresenterTone, RETICLE_WS_PATH, ReticleTool } from '@reticlehq/core';
import { HUMAN_DONE, UiRole, connectPeer } from '@reticlehq/computer-use';
import type { Peer, UiDriver, UiRead } from '@reticlehq/computer-use';
import { Bridge } from './bridge.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { LIVE_CONTROL_TOOLS } from '@/portal/session/live-control-tools.js';
import { makeDeps, waitUntil } from './bridge.test-harness.js';

/** The live-control tools are not in the harness's list: called by name here. */
function callTool(deps: ToolDeps, name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = LIVE_CONTROL_TOOLS.find((one) => one.name === name);
  if (tool === undefined) {
    throw new Error(`no tool ${name}`);
  }
  return Promise.resolve(tool.handler(deps, args));
}

/**
 * A long task stops for the person: a 2FA code, a captcha. The agent's `yield` with a question
 * reached a desktop session as a PRESENTER post, and the realm refused it: the person saw no
 * question, and could not say that they were done. Now the HUD shows the question, and "Done" on
 * the HUD reaches the agent as the person's message.
 */
class Still implements UiDriver {
  subject(): { app: string; pid: number } {
    return { app: 'Discord', pid: 9 };
  }

  read(): Promise<UiRead> {
    return Promise.resolve({
      root: {
        role: UiRole.WINDOW,
        name: 'Discord',
        states: [],
        children: [],
        frame: [0, 0, 400, 300],
      },
      unread: 0,
      unmapped: [],
    });
  }

  reach() {
    return Promise.resolve({ reach: 'yes' as const });
  }

  act(): ReturnType<UiDriver['act']> {
    return Promise.reject(new Error('no action in this test'));
  }
}

describe("the person's turn on a desktop session", () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let peer: Peer;
  const turns: { state: string; tone?: string; text?: string }[] = [];
  let pressDone: (() => void) | undefined;

  beforeAll(async () => {
    bridge = new Bridge({ port: 0, token: 'turn-test-token' });
    const port = await bridge.ready;
    deps = makeDeps(bridge);
    peer = connectPeer({
      url: `ws://${LOOPBACK_HOST}:${String(port)}${RETICLE_WS_PATH}`,
      token: 'turn-test-token',
      sessionId: 'cu-turn',
      projectId: 'cu-turn',
      driver: new Still(),
      now: () => Date.now(),
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
          pressDone = listener;
        },
      },
    });
    await peer.ready;
    await waitUntil(() => 1 === bridge.sessions.count());
  });

  afterAll(async () => {
    peer.close();
    await bridge.close();
  });

  it('shows the question on the HUD, and Done reaches the agent', async () => {
    await callTool(deps, ReticleTool.YIELD, { mode: PresenterTone.ASK, note: 'Type the 2FA code' });
    await waitUntil(() => turns.some((turn) => turn.tone === PresenterTone.ASK));
    expect(turns.find((turn) => turn.tone === PresenterTone.ASK)?.text).toContain(
      'Type the 2FA code',
    );

    pressDone?.();
    let heard: unknown[] = [];
    for (let tries = 0; tries < 50 && 0 === heard.length; tries += 1) {
      await new Promise((done) => setTimeout(done, 40));
      const answer = (await callTool(deps, ReticleTool.MESSAGES, {})) as { messages: unknown[] };
      heard = answer.messages;
    }
    expect(JSON.stringify(heard)).toContain(HUMAN_DONE);
  });
});
