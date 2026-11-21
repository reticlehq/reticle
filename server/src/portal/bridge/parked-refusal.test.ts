/**
 * A window the agent detached is refused by the bridge, and that refusal is not a missing SDK.
 *
 * Reported from the field (#2435): an agent detached a tab, the tab reloaded, and the bridge
 * refused it as parked. `reticle open` then said the SDK was missing. The bridge closed the socket
 * but recorded nothing, so the no-session diagnosis and `open` reasoned from an absence. These pin
 * that the bridge records the refusal, and that `open` reads it before it guesses at the SDK.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MessageKind, RETICLE_PROTOCOL_VERSION, RETICLE_WS_PATH } from '@reticlehq/core';
import { NoSessionReason } from '@reticlehq/core/telemetry';
import { Bridge } from './bridge.js';
import { SESSION_PARKED_REASON } from '@/portal/session/facts/session-replaced.js';
import { startNoSessionWatch } from '@/portal/session/no-session-watch.js';
import { openFailureNote } from '@/command/cli/answers/open-note.js';
import { currentRefusedUrl, statusPayload } from '@/status-payload.js';
import { summarizeStatus } from '@/command/cli/launch/cli-launch.js';

const PAGE_URL = 'http://localhost:5173/review';
const PROJECT = 'acme-web-9f3c1d';
const SESSION_ID = 'detached-tab';

const bridges: Bridge[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

function hello(): Record<string, unknown> {
  return {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId: SESSION_ID,
    url: PAGE_URL,
    projectId: PROJECT,
    title: 'Review',
    adapters: [],
  };
}

/** Open a socket, send a hello, and resolve with the close code the bridge answers. */
function dial(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${RETICLE_WS_PATH}`, {
      origin: 'http://localhost',
    });
    sockets.push(socket);
    socket.once('open', () => {
      socket.send(JSON.stringify(hello()));
    });
    socket.once('close', (code: number) => {
      resolve(code);
    });
    socket.once('error', reject);
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

/** A bridge whose only tab the agent detached, and which then reloaded under the same id. */
async function detachedAndReloaded(): Promise<Bridge> {
  const bridge = new Bridge({ port: 0 });
  bridges.push(bridge);
  const port = await bridge.ready;
  const firstClose = dial(port);
  await waitUntil(() => 1 === bridge.sessions.count());
  bridge.sessions.park(bridge.sessions.resolve(SESSION_ID));
  await firstClose;
  // The reload: the same id from sessionStorage, refused again.
  expect(await dial(port)).toBe(1008);
  return bridge;
}

describe('a detached window that dials again', () => {
  it('is recorded as a refusal, with the page it named', async () => {
    const bridge = await detachedAndReloaded();
    const closure = bridge.sessions.lastClosure();
    expect(closure?.reason).toBe(SESSION_PARKED_REASON);
    expect(closure?.page).toEqual({ url: PAGE_URL, projectId: PROJECT });
  });

  it('makes `reticle open` of that page say the daemon refused it, not that the SDK is missing', async () => {
    const note = await openNoteAfterRefusal('http://localhost:5173/');
    expect(note).not.toContain('carries no Reticle SDK');
    expect(note).toContain('detached by the agent');
    expect(note).toContain(PAGE_URL);
  });

  it('keeps the SDK advice for an app on another origin', async () => {
    // The refusal is daemon-wide. Another app's parked tab says nothing about this app's SDK.
    const note = await openNoteAfterRefusal('http://localhost:3000/');
    expect(note).toContain('carries no Reticle SDK');
    expect(note).not.toContain('detached by the agent');
  });
});

/** The note `reticle open <openedUrl>` prints when the only refusal is the detached tab's. */
async function openNoteAfterRefusal(openedUrl: string): Promise<string> {
  const bridge = await detachedAndReloaded();
  const stop = startNoSessionWatch({
    sessions: bridge.sessions,
    port: 4400,
    initialized: true,
    probe: () => Promise.resolve([5173]),
  });
  try {
    expect(bridge.sessions.noSessionReason()).toBe(NoSessionReason.AUTH_REFUSED);
    const status = summarizeStatus(
      statusPayload(
        bridge.sessions.count(),
        bridge.sessions.list(),
        bridge.sessions.noSessionHint(),
        undefined,
        bridge.sessions.noSessionLead(),
        [],
        [],
        bridge.sessions.noSessionReason(),
        currentRefusedUrl(bridge.sessions),
      ),
    );
    return openFailureNote(4400, 4400, status, openedUrl);
  } finally {
    stop();
  }
}

describe('`reticle open` with no refusal on record', () => {
  it('keeps the SDK advice when the daemon refused nothing', () => {
    const note = openFailureNote(
      4400,
      4400,
      { whyReason: NoSessionReason.NO_LISTENER, whyLead: 'nothing is listening' },
      PAGE_URL,
    );
    expect(note).toContain('carries no Reticle SDK');
  });

  it('keeps the SDK advice when the refused page is unknown', () => {
    const note = openFailureNote(
      4400,
      4400,
      { whyReason: NoSessionReason.AUTH_REFUSED, whyLead: 'a page was refused' },
      PAGE_URL,
    );
    expect(note).toContain('carries no Reticle SDK');
  });
});
