/**
 * An id-less yield with several projects connected releases the one tab this caller drove (#1258).
 *
 * Yield is non-destructive: it only hands the tab back to the human. It resolved its session like a
 * destructive action, so with two projects connected an id-less call got the "which session?"
 * refusal, and an agent that had just finished driving one tab had to look its id up to let go.
 *
 * Real sessions on a real bridge, tagged with project ids, so the refusal and the project scope are
 * the manager's own rather than a fake's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  LOOPBACK_HOST,
  MessageKind,
  PresenterTone,
  RETICLE_WS_PATH,
  ReticleTool,
} from '@reticlehq/core';
import { Bridge } from '@/portal/bridge/bridge.js';
import { LIVE_CONTROL_TOOLS } from './live-control-tools.js';
import type { ToolDef } from '@/surface/tools/tools.js';

let bridge: Bridge;
let port: number;
const open: WebSocket[] = [];

beforeEach(async () => {
  bridge = new Bridge({ port: 0 });
  port = await bridge.ready;
});

afterEach(async () => {
  for (const ws of open.splice(0)) ws.close();
  await bridge.close();
});

function connect(sessionId: string, projectId: string): Promise<void> {
  return new Promise((resolve) => {
    const sock = new WebSocket(`ws://${LOOPBACK_HOST}:${String(port)}${RETICLE_WS_PATH}`, {
      origin: 'http://localhost',
    });
    open.push(sock);
    sock.on('open', () => {
      sock.send(
        JSON.stringify({
          kind: MessageKind.HELLO,
          protocolVersion: 1,
          sessionId,
          projectId,
          url: `http://localhost:3000/${projectId}`,
          title: sessionId,
          adapters: [],
          hasCapabilities: false,
        }),
      );
      sock.on('message', () => undefined);
      resolve();
    });
  });
}

async function connected(...tabs: [string, string][]): Promise<void> {
  for (const [id, project] of tabs) await connect(id, project);
  for (let i = 0; i < 100 && bridge.sessions.count() < tabs.length; i++) {
    await new Promise<void>((r) => setTimeout(r, 20));
  }
}

/** Mark a session as driven, the way an act does: a remembered cursor. */
const drive = (id: string): void => {
  bridge.sessions.resolve(id).lastAct.markActed(7, 'click', 0);
};

const yieldNow = async (args: Record<string, unknown> = {}) => {
  const tool = LIVE_CONTROL_TOOLS.find((t): t is ToolDef => t.name === ReticleTool.YIELD);
  if (tool === undefined) throw new Error('no yield tool');
  return (await tool.handler({ sessions: bridge.sessions } as never, {
    mode: PresenterTone.WAITING,
    ...args,
  })) as Record<string, unknown>;
};

describe('an id-less yield with several projects connected', () => {
  it('yields the one session this caller drove', async () => {
    await connected(['shop-1', 'shop'], ['admin-1', 'admin']);
    drive('shop-1');

    const result = await yieldNow();

    expect(result['yielded']).toBe(true);
    expect(result['sessionId']).toBe('shop-1');
  });

  it('still asks when no session was driven', async () => {
    await connected(['shop-1', 'shop'], ['admin-1', 'admin']);
    await expect(yieldNow()).rejects.toThrow(/different projects are connected/);
  });

  it('still asks when more than one session was driven', async () => {
    await connected(['shop-1', 'shop'], ['admin-1', 'admin']);
    drive('shop-1');
    drive('admin-1');
    await expect(yieldNow()).rejects.toThrow(/different projects are connected/);
  });

  // The fallback must not cross the project scope: a driven tab from another project is not this
  // caller's to hand back when the daemon is scoped to a project with nothing connected.
  it("keeps the scope's refusal rather than yielding another project's driven tab", async () => {
    await connected(['admin-1', 'admin']);
    drive('admin-1');
    bridge.sessions.setDefaultScope({ projectId: 'shop' });

    await expect(yieldNow()).rejects.toThrow();
  });

  it('never overrides a session the caller named', async () => {
    await connected(['shop-1', 'shop'], ['admin-1', 'admin']);
    drive('shop-1');
    await expect(yieldNow({ sessionId: 'gone' })).rejects.toThrow(/gone/);
  });
});
