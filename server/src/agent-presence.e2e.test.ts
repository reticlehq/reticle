import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  AGENT_STOPPED_NOTICE,
  RETICLE_WS_PATH,
  ReticleCommand,
  MessageKind,
  SessionState,
} from '@reticlehq/core';
import { MCP_SSE_PATH } from '@reticlehq/core';
import { createSharedServer, type SharedServer } from './http-server.js';
import { Bridge } from './bridge/bridge.js';
import { endAllSessions } from './session/session-reaper.js';

/**
 * End-to-end proof of the agent-independent presence chain through the REAL wiring:
 * agent's SSE drops → SharedServer presence(false) → endAllSessions → Session.autoEnd →
 * PRESENTER push over the WS bridge → the browser panel.
 * No mocks in the path: a real Bridge, a real Session, a real WebSocket browser stand-in.
 */

let shared: SharedServer | undefined;
let bridge: Bridge | undefined;
/** Every presence transition the stack reported, so a test can wait for one instead of guessing. */
let presence: boolean[] = [];

afterEach(async () => {
  await bridge?.close();
  await shared?.close();
  shared = undefined;
  bridge = undefined;
  presence = [];
});

/** Replicates the three lines of production wiring in index.ts (startDaemon). Returns the bound port. */
async function startStack(): Promise<number> {
  shared = createSharedServer();
  shared.attachMcp(fakeMcpServer);
  const srv = shared.httpServer;
  bridge = new Bridge({ port: 0, server: srv });
  const b = bridge;
  shared.attachAgentPresence((connected) => {
    presence.push(connected);
    if (!connected) endAllSessions(b.sessions, AGENT_STOPPED_NOTICE);
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return (srv.address() as AddressInfo).port;
}

/** A no-op McpServer that starts its transport so the SSE response headers flush. */
function fakeMcpServer(): McpServer {
  return {
    connect: (transport: { start: () => Promise<void> }) => transport.start(),
    close: () => Promise.resolve(),
  } as unknown as McpServer;
}

/** Minimal browser SDK stand-in: HELLOs to register a session, records the commands it receives. */
class FakeBrowser {
  readonly received: { name: string; args: Record<string, unknown> }[] = [];
  readonly #ws: WebSocket;
  constructor(
    port: number,
    private readonly sessionId: string,
  ) {
    const host = '127.0.0.1';
    this.#ws = new WebSocket(`ws://${host}:${String(port)}${RETICLE_WS_PATH}`, {
      origin: 'http://localhost',
    });
  }
  open(): Promise<void> {
    return new Promise((resolve) => {
      this.#ws.on('open', () => {
        this.#ws.send(
          JSON.stringify({
            kind: MessageKind.HELLO,
            protocolVersion: 1,
            sessionId: this.sessionId,
            url: 'http://localhost:3000/checkout',
            title: 'Checkout',
            adapters: [],
            hasCapabilities: false,
          }),
        );
        this.#ws.on('message', (raw) => {
          const msg = JSON.parse((raw as Buffer).toString('utf8')) as Record<string, unknown>;
          if (msg['kind'] === MessageKind.COMMAND) {
            this.received.push({
              name: msg['name'] as string,
              args: (msg['args'] ?? {}) as Record<string, unknown>,
            });
          }
        });
        resolve();
      });
    });
  }
  close(): void {
    this.#ws.close();
  }
}

function openSse(port: number): Promise<http.ClientRequest> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: MCP_SSE_PATH, agent: false }, () =>
      resolve(req),
    );
    req.on('error', () => undefined);
  });
}

/**
 * Wait until `condition` holds, polling, instead of sleeping a fixed number of milliseconds and
 * hoping.
 *
 * This file used to pause a flat 60ms between every step. Sixty milliseconds is a statement about the
 * machine, not about the system under test, so it passed on a developer laptop and failed on a loaded
 * CI runner — the flake mode this repo already knows about and writes down in CLAUDE.md.
 *
 * The specific failure: the pause after `openSse` was standing in for "the server has registered the
 * agent as present". When it had not, `agent.destroy()` produced no true->false transition, so
 * `endAllSessions` never ran, no PRESENTER command was pushed, and the assertion failed with the
 * uninformative `expected undefined to be defined`.
 *
 * A generous timeout costs nothing when the condition is already true, which is the normal case. It
 * is deliberately BELOW vitest's own 5s test timeout: at 5s vitest's timeout fired first and the
 * failure read `Test timed out in 5000ms`, which says nothing about which step never happened.
 */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A fixed pause, used ONLY to assert that something did NOT happen. You cannot poll for the absence
 * of an event, so a negative check has to give the system a window to get it wrong in.
 */
const quietWindow = (ms = 250): Promise<void> => new Promise((r) => setTimeout(r, ms));

const hasPresenterNotice = (browser: FakeBrowser): boolean =>
  browser.received.some((c) => c.name === ReticleCommand.PRESENTER);

describe('agent presence → panel notice (end to end)', () => {
  it('drops a clear ended notice to the browser when the last agent disconnects', async () => {
    const port = await startStack();
    const browser = new FakeBrowser(port, 'sess-presence');
    await browser.open();
    await waitFor(() => 1 === bridge?.sessions.count(), 'the browser session to register');

    // An agent attaches, then stops (its MCP connection drops).
    const agent = await openSse(port);
    await waitFor(() => true === presence.at(-1), 'the agent SSE to register as present');
    agent.destroy();
    await waitFor(() => hasPresenterNotice(browser), 'the ended notice to reach the browser');

    const presenter = browser.received.find((c) => c.name === ReticleCommand.PRESENTER);
    expect(presenter).toBeDefined();
    expect(presenter?.args['state']).toBe(SessionState.ENDED);
    expect(presenter?.args['text']).toBe(AGENT_STOPPED_NOTICE);
    browser.close();
  });

  it('does NOT end the session while another agent is still attached', async () => {
    const port = await startStack();
    const browser = new FakeBrowser(port, 'sess-two-agents');
    await browser.open();
    await waitFor(() => 1 === bridge?.sessions.count(), 'the browser session to register');

    const a = await openSse(port);
    const b = await openSse(port);
    await waitFor(() => true === presence.at(-1), 'both agent SSEs to register as present');
    a.destroy(); // one agent leaves — the other is still driving
    await quietWindow(); // negative check: give it a window to wrongly end the session

    expect(hasPresenterNotice(browser)).toBe(false);

    b.destroy(); // now the last agent leaves → the human gets the notice
    await waitFor(
      () => hasPresenterNotice(browser),
      'the ended notice after the last agent leaves',
    );
    expect(hasPresenterNotice(browser)).toBe(true);
    browser.close();
  });
});
