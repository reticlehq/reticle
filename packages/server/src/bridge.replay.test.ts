import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventType, HumanControlKind, RETICLE_WS_PATH, MessageKind } from '@reticlehq/protocol';
import { Bridge } from './bridge.js';

/**
 * Replay-from-panel wiring: a human clicks ▶ on a saved flow in the panel, which crosses the WS as a
 * HUMAN_CONTROL/replay event. The bridge must route it to the daemon's replay handler (the Session
 * can't reach the flow store) and fire a session-ready hook so the daemon can push the flow list.
 */

const bridges: Bridge[] = [];
const clients: PanelClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const b of bridges.splice(0)) await b.close();
});

/** A minimal browser stand-in: HELLOs to register a session, then emits panel control events. */
class PanelClient {
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
        this.#send({
          kind: MessageKind.HELLO,
          protocolVersion: 1,
          sessionId: this.sessionId,
          url: 'http://localhost:3000/checkout',
          title: 'Checkout',
          adapters: [],
          hasCapabilities: false,
        });
        resolve();
      });
    });
  }
  emitControl(data: Record<string, unknown>): void {
    this.#send({
      kind: MessageKind.EVENT,
      event: { t: 0, type: EventType.HUMAN_CONTROL, sessionId: this.sessionId, data },
    });
  }
  close(): void {
    this.#ws.close();
  }
  #send(obj: unknown): void {
    this.#ws.send(JSON.stringify(obj));
  }
}

function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitUntil timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function connect(sessionId: string): Promise<{ bridge: Bridge; client: PanelClient }> {
  const bridge = new Bridge({ port: 0 });
  bridges.push(bridge);
  const port = await bridge.ready;
  const client = new PanelClient(port, sessionId);
  clients.push(client);
  await client.open();
  await waitUntil(() => bridge.sessions.count() === 1);
  return { bridge, client };
}

describe('replay-from-panel wiring (bridge)', () => {
  it('routes a panel REPLAY control to the daemon handler (not the in-session control path)', async () => {
    const { bridge, client } = await connect('panel');
    const calls: { sessionId: string; flowName: string }[] = [];
    bridge.attachReplay((sessionId, flowName) => calls.push({ sessionId, flowName }));
    client.emitControl({ kind: HumanControlKind.REPLAY, text: 'checkout' });
    await waitUntil(() => calls.length === 1);
    expect(calls[0]?.flowName).toBe('checkout');
    expect(calls[0]?.sessionId).toBe('panel');
  });

  it('a non-replay human control is NOT routed to the replay handler', async () => {
    const { bridge, client } = await connect('panel2');
    const calls: string[] = [];
    bridge.attachReplay((_s, flowName) => calls.push(flowName));
    client.emitControl({ kind: HumanControlKind.PAUSE });
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toHaveLength(0);
  });

  it('fires the session-ready hook on connect so the daemon can push the flow list', async () => {
    const bridge = new Bridge({ port: 0 });
    bridges.push(bridge);
    const seen: string[] = [];
    bridge.attachSessionReady((session) => seen.push(session.id));
    const port = await bridge.ready;
    const client = new PanelClient(port, 'ready-tab');
    clients.push(client);
    await client.open();
    await waitUntil(() => seen.length === 1);
    expect(seen[0]).toBe('ready-tab');
  });
});
