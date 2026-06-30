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
} from '@reticle/protocol';
import { createSharedServer, MCP_SSE_PATH, type SharedServer } from './http-server.js';
import { Bridge } from './bridge.js';
import { endAllSessions } from './session/session-reaper.js';

/**
 * End-to-end proof of the agent-independent presence chain through the REAL wiring:
 *   agent's SSE drops → SharedServer presence(false) → endAllSessions → Session.autoEnd →
 *   PRESENTER push over the WS bridge → the browser panel.
 * No mocks in the path: a real Bridge, a real Session, a real WebSocket browser stand-in.
 */

let shared: SharedServer | undefined;
let bridge: Bridge | undefined;

afterEach(async () => {
  await bridge?.close();
  await shared?.close();
  shared = undefined;
  bridge = undefined;
});

/** Replicates the three lines of production wiring in index.ts (startDaemon). Returns the bound port. */
async function startStack(): Promise<number> {
  shared = createSharedServer();
  shared.attachMcp(fakeMcpServer);
  const srv = shared.httpServer;
  bridge = new Bridge({ port: 0, server: srv });
  const b = bridge;
  shared.attachAgentPresence((connected) => {
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
    this.#ws = new WebSocket(`ws://${host}:${String(port)}${RETICLE_WS_PATH}`);
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

const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('agent presence → panel notice (end to end)', () => {
  it('drops a clear ended notice to the browser when the last agent disconnects', async () => {
    const port = await startStack();
    const browser = new FakeBrowser(port, 'sess-presence');
    await browser.open();
    await settle();
    expect(bridge?.sessions.count()).toBe(1);

    // An agent attaches, then stops (its MCP connection drops).
    const agent = await openSse(port);
    await settle();
    agent.destroy();
    await settle();

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
    await settle();

    const a = await openSse(port);
    const b = await openSse(port);
    await settle();
    a.destroy(); // one agent leaves — the other is still driving
    await settle();

    expect(browser.received.some((c) => c.name === ReticleCommand.PRESENTER)).toBe(false);

    b.destroy(); // now the last agent leaves → the human gets the notice
    await settle();
    expect(browser.received.some((c) => c.name === ReticleCommand.PRESENTER)).toBe(true);
    browser.close();
  });
});
