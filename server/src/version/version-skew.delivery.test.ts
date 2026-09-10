/**
 * Skew reaches the agent on an ORDINARY tool call — the whole point of the channel.
 *
 * Every earlier check reported somewhere an agent does not look: `reticle_sessions.versionSkew`,
 * which an agent driving a flow never calls, and a CLI stderr line no agent reads. This is the test
 * that the fact actually arrives: connect a page announcing a foreign contract, then call the most
 * boring tool there is and look for it on the result.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { RETICLE_WS_PATH, LOOPBACK_HOST, MessageKind } from '@reticlehq/core';
import { Bridge } from '../bridge/bridge.js';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { runTool } from '../tools/invoke-tool.js';
import { makeDeps } from '../bridge/bridge.test-harness.js';
import { resetVersionSkew } from './version-nudge.js';

let bridge: Bridge;
let deps: ToolDeps;
let port: number;
const open: WebSocket[] = [];

beforeAll(async () => {
  bridge = new Bridge({ port: 0 });
  port = await bridge.ready;
  deps = makeDeps(bridge);
});

afterAll(async () => {
  for (const ws of open.splice(0)) ws.close();
  await bridge.close();
});

beforeEach(() => resetVersionSkew());

/** A page announcing whatever version + contract we want it to claim. */
function connect(opts: { sessionId: string; version?: string; contract?: string }): Promise<void> {
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
          sessionId: opts.sessionId,
          url: 'http://localhost:3000/',
          title: opts.sessionId,
          adapters: [],
          hasCapabilities: false,
          ...(opts.version === undefined ? {} : { sdkVersion: opts.version }),
          ...(opts.contract === undefined ? {} : { contract: opts.contract }),
        }),
      );
      sock.on('message', () => undefined);
      resolve();
    });
  });
}

/**
 * Wait for THIS session, not for a count.
 *
 * Counting was wrong on a shared bridge: sessions from earlier cases are still connected, so
 * `count() >= 1` was already true and every case raced its own HELLO. It made the "delivered once"
 * case pass for the wrong reason — its HELLO had not landed yet, so there was nothing to deliver —
 * and then leaked that skew into the NEXT case, which is the one that failed.
 */
async function waitForSession(sessionId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (bridge.sessions.get(sessionId) !== undefined) return;
    await new Promise<void>((r) => setTimeout(r, 20));
  }
  throw new Error(`session ${sessionId} never connected`);
}

const call = (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return runTool(tool, deps, args);
};

describe('a skewed page is reported on the next tool result', () => {
  it('rides out on reticle_sessions — and names a fix', async () => {
    await connect({ sessionId: 'skewed', version: '2.2.1', contract: 'deadbeef' });
    await waitForSession('skewed');

    const result = (await call('reticle_sessions')) as {
      version_skew?: { pair: string; action: string };
    };
    expect(result.version_skew?.pair).toBe('sdk');
    expect(result.version_skew?.action).toContain('2.2.1');
    expect(result.version_skew?.action).toMatch(/reticle update|npm i -D/);
  });

  it('is delivered ONCE — the second call is clean', async () => {
    await connect({ sessionId: 'skewed-2', version: '2.2.1', contract: 'deadbeef' });
    await waitForSession('skewed-2');
    await call('reticle_sessions');
    const second = (await call('reticle_sessions')) as { version_skew?: unknown };
    expect(second.version_skew).toBeUndefined();
  });

  it('says nothing at all when the page agrees with this build', async () => {
    const { CONTRACT_FINGERPRINT } = await import('@reticlehq/core');
    const { SERVER_VERSION } = await import('./server-version.js');
    await connect({
      sessionId: 'in-sync',
      version: SERVER_VERSION,
      contract: CONTRACT_FINGERPRINT,
    });
    await waitForSession('in-sync');
    const result = (await call('reticle_sessions')) as { version_skew?: unknown };
    expect(result.version_skew).toBeUndefined();
  });

  it('stays silent for a page on a DIFFERENT version that speaks the same contract', async () => {
    // The reason the fingerprint exists: a patch bump that renamed nothing must not warn, or the
    // warning is noise by the third release and nobody reads the one that matters.
    const { CONTRACT_FINGERPRINT } = await import('@reticlehq/core');
    await connect({ sessionId: 'patch-behind', version: '0.0.1', contract: CONTRACT_FINGERPRINT });
    await waitForSession('patch-behind');
    const result = (await call('reticle_sessions')) as { version_skew?: unknown };
    expect(result.version_skew).toBeUndefined();
  });
});
