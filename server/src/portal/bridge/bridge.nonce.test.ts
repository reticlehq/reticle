import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  HelloEnv,
  HelloScope,
  MessageKind,
  PRODUCTION_REFUSAL_PREFIX,
  ProductionRule,
  ReticleCommand,
  RETICLE_PROTOCOL_VERSION,
  RETICLE_WS_PATH,
} from '@reticlehq/core';
import { Bridge } from './bridge.js';

const MACHINE_TOKEN = 'machine-pairing-token';
const PROD_ORIGIN = 'https://app.example.com';

const bridges: Bridge[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

function hello(
  sessionId: string,
  token: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...extra,
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId,
    url: `${PROD_ORIGIN}/`,
    title: 'Nonce test',
    adapters: [],
    token,
  };
}

async function makeBridge(clock: () => number = () => Date.now()) {
  const bridge = new Bridge({ port: 0, token: MACHINE_TOKEN, clock });
  bridges.push(bridge);
  return { bridge, port: await bridge.ready };
}

function openSocket(port: number, origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${RETICLE_WS_PATH}`, { origin });
    sockets.push(socket);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Send a HELLO; resolve 'accepted' once the session registers, or the close code. */
async function sayHello(
  bridge: Bridge,
  port: number,
  sessionId: string,
  token: string,
  extra: Record<string, unknown> = {},
): Promise<'accepted' | number> {
  const socket = await openSocket(port, PROD_ORIGIN);
  return new Promise((resolve) => {
    socket.once('close', (code) => resolve(code));
    const poll = setInterval(() => {
      if (bridge.sessions.get(sessionId) !== undefined) {
        clearInterval(poll);
        resolve('accepted');
      }
    }, 10);
    socket.once('close', () => clearInterval(poll));
    socket.send(JSON.stringify(hello(sessionId, token, extra)));
  });
}

describe('a session nonce on the bridge', () => {
  it('admits the nonce origin and accepts the nonce in place of the pairing token', async () => {
    const { bridge, port } = await makeBridge();
    const { nonce } = bridge.nonces.mint({ origin: PROD_ORIGIN });
    expect(await sayHello(bridge, port, 'tab-1', nonce)).toBe('accepted');
  });

  it('refuses a second tab that presents the same nonce', async () => {
    const { bridge, port } = await makeBridge();
    const { nonce } = bridge.nonces.mint({ origin: PROD_ORIGIN });
    expect(await sayHello(bridge, port, 'tab-1', nonce)).toBe('accepted');
    expect(await sayHello(bridge, port, 'tab-2', nonce)).toBe(1008);
  });

  it('refuses an expired nonce, and its origin with it', async () => {
    let now = 1_000;
    const { bridge, port } = await makeBridge(() => now);
    const { nonce } = bridge.nonces.mint({ origin: PROD_ORIGIN, ttlMs: 500 });
    now += 500;
    await expect(openSocket(port, PROD_ORIGIN)).rejects.toThrow(/403/);
    expect(bridge.nonces.redeem(nonce, 'tab-1')).toBeUndefined();
  });

  it('never admits a public origin without a live nonce for it', async () => {
    const { port } = await makeBridge();
    await expect(openSocket(port, PROD_ORIGIN)).rejects.toThrow(/403/);
  });

  it('refuses a production HELLO that carries the machine pairing token', async () => {
    const { bridge, port } = await makeBridge();
    bridge.nonces.mint({ origin: PROD_ORIGIN });
    const production = { env: HelloEnv.PRODUCTION, scope: HelloScope.ACT };
    expect(await sayHello(bridge, port, 'tab-1', MACHINE_TOKEN, production)).toBe(1008);
  });

  it('opens a production session from a production nonce, with the scope it granted', async () => {
    const { bridge, port } = await makeBridge();
    const { nonce } = bridge.nonces.mint({
      origin: PROD_ORIGIN,
      production: { scope: HelloScope.OBSERVE },
    });
    const production = { env: HelloEnv.PRODUCTION, scope: HelloScope.ACT };
    expect(await sayHello(bridge, port, 'tab-1', nonce, production)).toBe('accepted');
    expect(bridge.sessions.get('tab-1')?.production?.scope).toBe(HelloScope.OBSERVE);
  });

  it('refuses an act on a production session where it is dispatched, and sends nothing', async () => {
    const { bridge, port } = await makeBridge();
    const { nonce } = bridge.nonces.mint({
      origin: PROD_ORIGIN,
      production: { scope: HelloScope.OBSERVE },
    });
    const production = { env: HelloEnv.PRODUCTION, scope: HelloScope.OBSERVE };
    expect(await sayHello(bridge, port, 'tab-1', nonce, production)).toBe('accepted');
    const session = bridge.sessions.get('tab-1');
    const sent: string[] = [];
    for (const socket of sockets) socket.on('message', (raw: Buffer) => sent.push(raw.toString()));
    const result = await session?.command(ReticleCommand.ACT, { ref: 'e1', action: 'click' });
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain(`${PRODUCTION_REFUSAL_PREFIX}${ProductionRule.OBSERVE_ONLY}`);
    expect(sent.filter((frame) => frame.includes('"act"'))).toEqual([]);
  });
});
