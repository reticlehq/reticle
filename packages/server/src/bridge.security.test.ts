import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  EventType,
  RETICLE_PROTOCOL_VERSION,
  RETICLE_WS_PATH,
  MessageKind,
  TRANSPORT_LIMITS,
} from '@reticlehq/core';
import { Bridge } from './bridge.js';

const bridges: Bridge[] = [];
const sockets: WebSocket[] = [];

function hello(sessionId: string, token?: string): Record<string, unknown> {
  return {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId,
    url: 'http://localhost/',
    title: 'Security test',
    adapters: [],
    ...(token === undefined ? {} : { token }),
  };
}

async function makeBridge(options: Omit<ConstructorParameters<typeof Bridge>[0], 'port'> = {}) {
  const bridge = new Bridge({ port: 0, ...options });
  bridges.push(bridge);
  return { bridge, port: await bridge.ready };
}

// Default to a loopback Origin — a real browser SDK always sends one. Pass `null` to simulate a
// non-browser local process that omits Origin entirely.
function openSocket(port: number, origin: string | null = 'http://localhost'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${RETICLE_WS_PATH}`, {
      ...(origin === null ? {} : { origin }),
    });
    sockets.push(socket);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once('close', (code) => resolve(code));
  });
}

function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = (): void => {
      if (condition()) {
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('condition timed out'));
      } else {
        setTimeout(poll, 10);
      }
    };
    poll();
  });
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

describe('Bridge security boundary', () => {
  it('rejects non-local browser origins by default', async () => {
    const { port } = await makeBridge();
    await expect(openSocket(port, 'https://evil.example')).rejects.toThrow(
      /Unexpected server response: 403/,
    );
    await expect(openSocket(port, 'http://127.evil.example')).rejects.toThrow(
      /Unexpected server response: 403/,
    );
  });

  it('accepts configured origins and requires the pairing token', async () => {
    const { bridge, port } = await makeBridge({
      token: 'shared-secret',
      allowedOrigins: ['https://app.example'],
    });
    const bad = await openSocket(port, 'https://app.example');
    const badClosed = waitForClose(bad);
    bad.send(JSON.stringify(hello('bad', 'wrong-secret')));
    expect(await badClosed).toBe(1008);
    expect(bridge.sessions.count()).toBe(0);

    const good = await openSocket(port, 'https://app.example');
    good.send(JSON.stringify(hello('good', 'shared-secret')));
    await waitUntil(() => bridge.sessions.count() === 1);
    expect(bridge.sessions.get('good')).toBeDefined();
  });

  it('rejects a handshake with no Origin when no token is configured (non-browser local process)', async () => {
    const { port } = await makeBridge();
    await expect(openSocket(port, null)).rejects.toThrow(/Unexpected server response: 403/);
  });

  it('allows a no-Origin handshake when a token is configured (HELLO token check is the gate)', async () => {
    const { bridge, port } = await makeBridge({ token: 'shared-secret' });
    const socket = await openSocket(port, null);
    socket.send(JSON.stringify(hello('nobrowser', 'shared-secret')));
    await waitUntil(() => bridge.sessions.count() === 1);
    expect(bridge.sessions.get('nobrowser')).toBeDefined();
  });

  it('requires a token before binding beyond localhost', () => {
    expect(() => new Bridge({ port: 0, host: '0.0.0.0' })).toThrow(/pairing token/);
  });

  it('requires allowedOrigins when binding beyond localhost (else it rejects every browser)', () => {
    expect(() => new Bridge({ port: 0, host: '0.0.0.0', token: 'shared-secret' })).toThrow(
      /ALLOWED_ORIGINS/,
    );
  });

  it('rejects protocol mismatches with a distinct "upgrade" reason (not a generic drop)', async () => {
    const { bridge, port } = await makeBridge();
    const socket = await openSocket(port);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    socket.send(
      JSON.stringify({
        ...hello('old-client'),
        protocolVersion: RETICLE_PROTOCOL_VERSION + 1,
      }),
    );
    const { code, reason } = await closed;
    expect(code).toBe(1008);
    // The distinct reason is what stops the agent misdiagnosing a version skew as a port mismatch.
    expect(reason).toContain('protocol version mismatch');
    expect(bridge.sessions.count()).toBe(0);
  });

  it('keeps a replacement session when the older duplicate socket closes', async () => {
    const { bridge, port } = await makeBridge();
    const first = await openSocket(port);
    first.send(JSON.stringify(hello('same-id')));
    await waitUntil(() => bridge.sessions.count() === 1);

    const second = await openSocket(port);
    const firstClosed = waitForClose(first);
    second.send(JSON.stringify(hello('same-id')));
    expect(await firstClosed).toBe(1008);
    await waitUntil(() => bridge.sessions.count() === 1);

    second.send(
      JSON.stringify({
        kind: MessageKind.EVENT,
        event: {
          t: 1,
          type: EventType.SIGNAL,
          sessionId: 'same-id',
          data: { name: 'still-connected' },
        },
      }),
    );
    await waitUntil(() => bridge.sessions.resolve('same-id').eventsSince(0).length === 1);
  });

  it('caps concurrent sessions and message rate', async () => {
    const limitedSessions = await makeBridge({ maxSessions: 1 });
    const first = await openSocket(limitedSessions.port);
    first.send(JSON.stringify(hello('one')));
    await waitUntil(() => limitedSessions.bridge.sessions.count() === 1);
    const second = await openSocket(limitedSessions.port);
    const sessionLimitClose = waitForClose(second);
    second.send(JSON.stringify(hello('two')));
    expect(await sessionLimitClose).toBe(1013);

    const rateLimited = await makeBridge({ maxMessagesPerSecond: 2 });
    const noisy = await openSocket(rateLimited.port);
    noisy.send(JSON.stringify(hello('noisy')));
    noisy.send(JSON.stringify({ kind: MessageKind.COMMAND_RESULT, id: 'c1', ok: true }));
    const rateClose = waitForClose(noisy);
    noisy.send(JSON.stringify({ kind: MessageKind.COMMAND_RESULT, id: 'c2', ok: true }));
    expect(await rateClose).toBe(1008);
  });

  it('caps and expires unauthenticated pending handshakes', async () => {
    const limited = await makeBridge({
      maxPendingConnections: 1,
      helloTimeoutMs: 50,
    });
    const idle = await openSocket(limited.port);
    const idleClosed = waitForClose(idle);

    const excess = await openSocket(limited.port);
    const excessClosed = waitForClose(excess);
    expect(await excessClosed).toBe(1013);
    expect(await idleClosed).toBe(1008);
    expect(limited.bridge.sessions.count()).toBe(0);
  });

  it('rejects messages above the transport payload limit', async () => {
    const { port } = await makeBridge();
    const socket = await openSocket(port);
    const closed = waitForClose(socket);
    socket.send(Buffer.alloc(TRANSPORT_LIMITS.MAX_MESSAGE_BYTES + 1));
    expect(await closed).toBe(1009);
  });
});
