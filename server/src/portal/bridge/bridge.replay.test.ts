import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { EventType, HumanControlKind, RETICLE_WS_PATH, MessageKind } from '@reticlehq/core';
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
  await waitUntil(() => 1 === bridge.sessions.count());
  return { bridge, client };
}

describe('replay-from-panel wiring (bridge)', () => {
  it('routes a panel REPLAY control to the daemon handler (not the in-session control path)', async () => {
    const { bridge, client } = await connect('panel');
    const calls: { sessionId: string; flowName: string }[] = [];
    bridge.attachReplay((sessionId, flowName) => calls.push({ sessionId, flowName }));
    client.emitControl({ kind: HumanControlKind.REPLAY, text: 'checkout' });
    await waitUntil(() => 1 === calls.length);
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
    await waitUntil(() => 1 === seen.length);
    expect(seen[0]).toBe('ready-tab');
  });

  /**
   * The registration used to be a single slot, so a second `attachSessionReady` silently replaced
   * the first and the earlier handler simply never ran again. Nothing threw and nothing went red.
   *
   * It cost `app_instrumented` — the event that measures whether an app was ever instrumented, which
   * is the whole point of the 2.7.0 funnel work — on its first day: the call was correct, registered
   * before the flow-chip handler, and overwritten by it. The metric was permanently absent and the
   * only symptom was an empty column nobody would look at for months.
   */
  it('runs EVERY session-ready handler, not just the last one registered', async () => {
    const bridge = new Bridge({ port: 0 });
    bridges.push(bridge);
    const first: string[] = [];
    const second: string[] = [];
    bridge.attachSessionReady((session) => first.push(session.id));
    bridge.attachSessionReady((session) => second.push(session.id));
    const port = await bridge.ready;
    const client = new PanelClient(port, 'two-hooks');
    clients.push(client);
    await client.open();
    await waitUntil(() => 1 === first.length && 1 === second.length);
    expect(first).toEqual(['two-hooks']);
    expect(second).toEqual(['two-hooks']);
  });

  it('one handler throwing does not rob the others of their turn', async () => {
    const bridge = new Bridge({ port: 0 });
    bridges.push(bridge);
    const survived: string[] = [];
    bridge.attachSessionReady(() => {
      throw new Error('an observer blew up');
    });
    bridge.attachSessionReady((session) => survived.push(session.id));
    const port = await bridge.ready;
    const client = new PanelClient(port, 'resilient');
    clients.push(client);
    await client.open();
    await waitUntil(() => 1 === survived.length);
    expect(survived).toEqual(['resilient']);
  });
});
