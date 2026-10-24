import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { RETICLE_PROTOCOL_VERSION, RETICLE_WS_PATH, MessageKind } from '@reticlehq/core';
import { Bridge } from './bridge.js';
import type { OriginFollowRequest } from './origin/origin-follow.js';

/**
 * A drive that leaves its first origin keeps its session.
 *
 * Found on a hosted check of a public site: the journey opened `www.wikipedia.org`, clicked through
 * to `en.wikipedia.org`, and the bridge refused the new page at the handshake because its allow-list
 * was fixed when the bridge was built. The drive lost its session on the step that mattered.
 *
 * The host now decides, per navigation, through `followNavigation`. Without the hook nothing changes.
 */

const TOKEN = 'follow-secret';
const WWW = 'https://www.example.org';
const EN = 'https://en.example.org';

const bridges: Bridge[] = [];
const sockets: WebSocket[] = [];

function hello(sessionId: string, url: string, token = TOKEN): string {
  return JSON.stringify({
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId,
    url,
    title: 'Follow test',
    adapters: [],
    token,
  });
}

async function makeBridge(follow?: (request: OriginFollowRequest) => boolean) {
  const bridge = new Bridge({
    port: 0,
    token: TOKEN,
    allowedOrigins: [WWW],
    ...(follow === undefined ? {} : { followNavigation: follow }),
  });
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

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(condition()).toBe(true);
}

/** Connect `sessionId` from the allow-listed origin, then let that page go, as a navigation does. */
async function startOnWww(bridge: Bridge, port: number, sessionId: string): Promise<void> {
  const first = await openSocket(port, WWW);
  first.send(hello(sessionId, `${WWW}/`));
  await until(() => bridge.sessions.get(sessionId) !== undefined);
  const gone = closed(first);
  first.close();
  await gone;
  await until(() => bridge.sessions.get(sessionId) === undefined);
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

describe('a session following its own navigation to another origin', () => {
  it('is refused at the handshake when the host set no policy', async () => {
    const { bridge, port } = await makeBridge();
    await startOnWww(bridge, port, 'drive-1');
    await expect(openSocket(port, EN)).rejects.toThrow(/Unexpected server response: 403/);
  });

  it('keeps the same session id when the host allows the move', async () => {
    const follow = vi.fn(() => true);
    const { bridge, port } = await makeBridge(follow);
    await startOnWww(bridge, port, 'drive-1');

    const next = await openSocket(port, EN);
    next.send(hello('drive-1', `${EN}/wiki/Main_Page`));
    await until(() => bridge.sessions.get('drive-1') !== undefined);

    expect(bridge.sessions.get('drive-1')?.url).toBe(`${EN}/wiki/Main_Page`);
    expect(follow).toHaveBeenCalledWith({
      sessionId: 'drive-1',
      from: WWW,
      to: EN,
      url: `${EN}/wiki/Main_Page`,
    });
  });

  it('reports the latest admitted origin as `from` on the next move', async () => {
    const follow = vi.fn(() => true);
    const { bridge, port } = await makeBridge(follow);
    await startOnWww(bridge, port, 'drive-1');
    const onEn = await openSocket(port, EN);
    onEn.send(hello('drive-1', `${EN}/`));
    await until(() => bridge.sessions.get('drive-1') !== undefined);
    const gone = closed(onEn);
    onEn.close();
    await gone;

    const onDe = await openSocket(port, 'https://de.example.org');
    onDe.send(hello('drive-1', 'https://de.example.org/'));
    await until(() => bridge.sessions.get('drive-1') !== undefined);
    expect(follow).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: EN, to: 'https://de.example.org' }),
    );
  });

  // The security half. A page on an origin nobody admitted must never START a session, and must
  // never take over one it did not come from, whatever the host's policy says about origins.
  it('refuses a page that names a session this bridge never admitted, without asking the host', async () => {
    const follow = vi.fn(() => true);
    const { bridge, port } = await makeBridge(follow);
    const stranger = await openSocket(port, 'https://evil.example');
    const code = closed(stranger);
    stranger.send(hello('never-seen', 'https://evil.example/'));
    expect(await code).toBe(1008);
    expect(bridge.sessions.get('never-seen')).toBeUndefined();
    expect(follow).not.toHaveBeenCalled();
  });

  it('refuses the move when the host says no', async () => {
    const { bridge, port } = await makeBridge(() => false);
    await startOnWww(bridge, port, 'drive-1');
    const next = await openSocket(port, EN);
    const code = closed(next);
    next.send(hello('drive-1', `${EN}/`));
    expect(await code).toBe(1008);
    expect(bridge.sessions.get('drive-1')).toBeUndefined();
  });

  it('refuses the move when the host policy throws', async () => {
    const { bridge, port } = await makeBridge(() => {
      throw new Error('policy store down');
    });
    await startOnWww(bridge, port, 'drive-1');
    const next = await openSocket(port, EN);
    const code = closed(next);
    next.send(hello('drive-1', `${EN}/`));
    expect(await code).toBe(1008);
    expect(bridge.sessions.get('drive-1')).toBeUndefined();
  });

  it('checks the pairing token before it asks the host', async () => {
    const follow = vi.fn(() => true);
    const { bridge, port } = await makeBridge(follow);
    await startOnWww(bridge, port, 'drive-1');
    const next = await openSocket(port, EN);
    const code = closed(next);
    next.send(hello('drive-1', `${EN}/`, 'wrong-token'));
    expect(await code).toBe(1008);
    expect(follow).not.toHaveBeenCalled();
    expect(bridge.sessions.get('drive-1')).toBeUndefined();
  });

  it('refuses a HELLO whose page address is on another origin than the socket', async () => {
    const follow = vi.fn(() => true);
    const { bridge, port } = await makeBridge(follow);
    await startOnWww(bridge, port, 'drive-1');
    const next = await openSocket(port, EN);
    const code = closed(next);
    next.send(hello('drive-1', 'https://other.example.org/'));
    expect(await code).toBe(1008);
    expect(follow).not.toHaveBeenCalled();
  });

  it('never admits a non-web origin on the follow path', async () => {
    const { port } = await makeBridge(() => true);
    await expect(openSocket(port, 'ftp://files.example.org')).rejects.toThrow(
      /Unexpected server response: 403/,
    );
  });
});
