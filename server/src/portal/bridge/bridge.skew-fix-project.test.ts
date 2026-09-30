/**
 * The skew remedy is asked about the project the page announced, not the daemon's cwd (#1135).
 *
 * A daemon is shared, and its cwd is often not the app that sent the HELLO. The HELLO carries the
 * page's `projectId`, and the remedy is only as good as the directory it reads `package.json` from.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CONTRACT_FINGERPRINT, LOOPBACK_HOST, MessageKind, RETICLE_WS_PATH } from '@reticlehq/core';
import { Bridge } from './bridge.js';

const asked: (string | undefined)[] = [];
let bridge: Bridge;
let port: number;
const open: WebSocket[] = [];

beforeAll(async () => {
  bridge = new Bridge({
    port: 0,
    sdkFix: (projectId) => {
      asked.push(projectId);
      return `fix for ${projectId ?? 'nobody'}`;
    },
  });
  port = await bridge.ready;
});

afterAll(async () => {
  for (const ws of open.splice(0)) ws.close();
  await bridge.close();
});

function hello(sessionId: string, projectId?: string): void {
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
        url: 'http://localhost:3000/',
        title: sessionId,
        adapters: [],
        hasCapabilities: false,
        sdkVersion: '2.2.1',
        contract: 'deadbeef',
        ...(projectId === undefined ? {} : { projectId }),
      }),
    );
    sock.on('message', () => undefined);
  });
}

/** Fifteen seconds, like the bridge harness: shorter waits have failed on a loaded Windows runner. */
async function waitForSession(sessionId: string): Promise<void> {
  for (let i = 0; i < 750; i++) {
    if (bridge.sessions.get(sessionId) !== undefined) return;
    await new Promise<void>((r) => setTimeout(r, 20));
  }
  throw new Error(`session ${sessionId} never connected`);
}

describe('a skewed HELLO asks for the fix of its own project', () => {
  it('passes the announced projectId to sdkFix', async () => {
    hello('from-acme', 'acme');
    await waitForSession('from-acme');

    expect(asked).toContain('acme');
  });

  it('does not ask at all for a page that is not skewed', async () => {
    const before = asked.length;
    const sock = new WebSocket(`ws://${LOOPBACK_HOST}:${String(port)}${RETICLE_WS_PATH}`, {
      origin: 'http://localhost',
    });
    open.push(sock);
    sock.on('open', () => {
      sock.send(
        JSON.stringify({
          kind: MessageKind.HELLO,
          protocolVersion: 1,
          sessionId: 'compatible',
          url: 'http://localhost:3000/',
          title: 'compatible',
          adapters: [],
          hasCapabilities: false,
          projectId: 'acme',
          contract: CONTRACT_FINGERPRINT,
        }),
      );
      sock.on('message', () => undefined);
    });
    await waitForSession('compatible');

    expect(asked.slice(before)).toEqual([]);
  });

  it('asks with no project when the page announced none, so the caller falls back', async () => {
    const before = asked.length;
    hello('anonymous');
    await waitForSession('anonymous');

    expect(asked.slice(before)).toEqual([undefined]);
  });
});
