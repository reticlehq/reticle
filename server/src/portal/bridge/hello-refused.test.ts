/**
 * A hello refused for anything but its token used to leave the no-session diagnosis blind.
 *
 * A page whose SDK is a different release than the daemon sends a HELLO that fails the wire schema.
 * The bridge closed the socket with `invalid message` and recorded nothing, so `init` ended on "the
 * SDK IS in the page and never dialled the bridge" about a page that dialled and was turned away,
 * and `reticle status` offered the generic port differential. The daemon is the only party that saw
 * the refusal; these pin that it remembers it, with the page, and that the diagnosis leads with it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RETICLE_PROTOCOL_VERSION, RETICLE_WS_PATH } from '@reticlehq/core';
import { NoSessionReason } from '@reticlehq/core/telemetry';
import { Bridge, WS_CLOSE_REASON } from './bridge.js';
import { explainNoSession } from '@/portal/session/no-session-diagnosis.js';
import { nextActionFor } from '@/portal/session/no-session-next-action.js';

const bridges: Bridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

const PAGE_URL = 'http://localhost:5173/';
const PROJECT = 'acme-web-9f3c1d';

/** Send one frame and resolve once the bridge closes the socket. */
function sendAndAwaitClose(port: number, frame: unknown): Promise<void> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${RETICLE_WS_PATH}`, {
      origin: 'http://localhost',
    });
    socket.once('open', () => {
      socket.send(JSON.stringify(frame));
    });
    socket.once('close', () => {
      resolve();
    });
    socket.once('error', () => {
      resolve();
    });
  });
}

describe('a hello that fails the wire contract is remembered', () => {
  it('records why, with the page and project the hello named', async () => {
    const bridge = new Bridge({ port: 0 });
    bridges.push(bridge);
    const port = await bridge.ready;

    // Right protocol number, wrong shape: the contract drifted while the version did not.
    await sendAndAwaitClose(port, {
      kind: 'hello',
      protocolVersion: RETICLE_PROTOCOL_VERSION,
      url: PAGE_URL,
      projectId: PROJECT,
    });

    const closure = bridge.sessions.lastClosure();
    expect(closure?.reason).toBe(WS_CLOSE_REASON.INVALID_HELLO);
    expect(closure?.page).toEqual({ url: PAGE_URL, projectId: PROJECT });
  });

  it('records the page on a protocol-number refusal too', async () => {
    const bridge = new Bridge({ port: 0 });
    bridges.push(bridge);
    const port = await bridge.ready;

    await sendAndAwaitClose(port, {
      kind: 'hello',
      protocolVersion: RETICLE_PROTOCOL_VERSION + 1,
      url: PAGE_URL,
    });

    expect(bridge.sessions.lastClosure()?.page).toEqual({ url: PAGE_URL });
  });

  it('records nothing for a frame that is not a hello — only an SDK sends one', async () => {
    const bridge = new Bridge({ port: 0 });
    bridges.push(bridge);
    const port = await bridge.ready;

    await sendAndAwaitClose(port, { kind: 'not-a-kind' });

    expect(bridge.sessions.lastClosure()).toBeUndefined();
  });
});

describe('the diagnosis leads with the refusal', () => {
  const facts = {
    everConnected: false,
    initialized: true,
    listening: [5173],
    port: 4400,
    helloRefused: { reason: WS_CLOSE_REASON.INVALID_HELLO, url: PAGE_URL, projectId: PROJECT },
  };

  it('says which page was refused, why, and the one-line fix', () => {
    const { message, reason } = explainNoSession(facts);
    expect(message).toContain(`the page at ${PAGE_URL} (project ${PROJECT})`);
    expect(message).toContain("was REFUSED because invalid message: the page's hello");
    expect(message).toContain('; fix: put @reticlehq/browser');
    expect(message).not.toMatch(/never dialled/);
    expect(reason).toBe(NoSessionReason.AUTH_REFUSED);
  });

  it('outranks a session that connected earlier', () => {
    expect(explainNoSession({ ...facts, everConnected: true }).message).toContain('REFUSED');
  });

  it('hands the agent the fix rather than an init or a reopen', () => {
    const next = nextActionFor({
      everConnected: true,
      initialized: false,
      listening: [5173],
      dev: undefined,
      helloRefused: WS_CLOSE_REASON.INVALID_HELLO,
    });
    expect(next.command).toBeUndefined();
    expect(next.reason).toContain('reticle stop');
  });
});
