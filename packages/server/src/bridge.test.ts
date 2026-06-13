import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import {
  EventType,
  IRIS_WS_PATH,
  IrisCommand,
  MessageKind,
  type ElementQuery,
} from '@iris/protocol';
import { Bridge } from './bridge.js';
import { BaselineStore } from './baselines.js';
import { RecordingStore } from './recordings.js';
import { TOOLS, type ToolDeps } from './tools.js';
import { IrisTool } from './tool-names.js';

/** A stand-in for the real @iris/browser SDK: replies to commands and emits events. */
class FakeBrowser {
  readonly #ws: WebSocket;
  matcher: (query: ElementQuery) => boolean = () => false;

  constructor(
    port: number,
    private readonly sessionId: string,
  ) {
    this.#ws = new WebSocket(`ws://127.0.0.1:${String(port)}${IRIS_WS_PATH}`);
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
        });
        this.#ws.on('message', (raw) => {
          this.#onMessage(JSON.parse((raw as Buffer).toString('utf8')) as Record<string, unknown>);
        });
        resolve();
      });
    });
  }

  emit(type: string, data: Record<string, unknown>, ref?: string): void {
    this.#send({
      kind: MessageKind.EVENT,
      event: { t: 0, type, sessionId: this.sessionId, ref, data },
    });
  }

  close(): void {
    this.#ws.close();
  }

  #onMessage(msg: Record<string, unknown>): void {
    if (msg['kind'] !== MessageKind.COMMAND) return;
    const id = msg['id'] as string;
    const name = msg['name'] as string;
    const args = (msg['args'] ?? {}) as Record<string, unknown>;
    let result: unknown = { ok: true };
    if (name === IrisCommand.MATCH) {
      const query = (args['query'] ?? {}) as ElementQuery;
      const matched = this.matcher(query);
      result = {
        matched,
        count: matched ? 1 : 0,
        elements: matched
          ? [
              {
                ref: 'e12',
                role: 'dialog',
                name: 'Order confirmed',
                states: ['visible'],
                visible: true,
              },
            ]
          : [],
      };
    } else if (name === IrisCommand.STATE_READ) {
      result = {
        stores: { workspace: { tab: args['store'] === 'workspace' ? 'open' : 'all' } },
        storeNames: ['workspace'],
        component: args['ref'] !== undefined ? { component: 'PayButton', hooks: [0] } : undefined,
      };
    } else if (name === IrisCommand.SNAPSHOT) {
      result = {
        tree: '- button "Pay" (ref=e7)\n- dialog "Order confirmed" (ref=e12)',
        status: { route: '/checkout' },
      };
    }
    this.#send({ kind: MessageKind.COMMAND_RESULT, id, ok: true, result });
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

const callTool = (
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> => {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.handler(deps, args);
};

describe('bridge round-trip (north-star)', () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let browser: FakeBrowser;

  beforeAll(async () => {
    bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    deps = {
      sessions: bridge.sessions,
      baselines: new BaselineStore(),
      recordings: new RecordingStore(),
    };
    browser = new FakeBrowser(port, 'demo');
    await browser.open();
    await waitUntil(() => bridge.sessions.count() === 1);
  });

  afterAll(async () => {
    browser.close();
    await bridge.close();
  });

  it('lists the connected session', async () => {
    const result = (await callTool(deps, 'iris_sessions')) as { sessions: unknown[] };
    expect(result.sessions).toHaveLength(1);
  });

  it('acts, observes the reaction, and asserts the full chain', async () => {
    // The agent clicks "Pay".
    const act = (await callTool(deps, 'iris_act', { ref: 'e7', action: 'click' })) as {
      since: number;
    };

    // The app reacts: POST 200, dialog opens, animation plays.
    browser.emit(EventType.NET_REQUEST, {
      method: 'POST',
      url: '/api/order',
      status: 200,
      durationMs: 142,
    });
    browser.emit(EventType.DOM_ADDED, { role: 'dialog', name: 'Order confirmed' }, 'e12');
    browser.emit(EventType.ANIM_END, { name: 'dialog-in' }, 'e12');
    browser.matcher = (q) => q.role === 'dialog' || (q.name ?? '').includes('Order confirmed');

    await waitUntil(() => bridge.sessions.resolve('demo').eventsSince(0).length >= 3);

    const observe = (await callTool(deps, 'iris_observe', { since: act.since })) as {
      summary: { network: number; animations: number };
    };
    expect(observe.summary.network).toBe(1);
    expect(observe.summary.animations).toBe(1);

    const net = (await callTool(deps, 'iris_network', { status: 200 })) as { calls: unknown[] };
    expect(net.calls).toHaveLength(1);

    // The single assert that covers the whole expectation.
    const verdict = (await callTool(deps, 'iris_assert', {
      timeout_ms: 1000,
      predicate: {
        kind: 'allOf',
        predicates: [
          { kind: 'net', method: 'POST', urlContains: '/api/order', status: 200 },
          { kind: 'element', query: { role: 'dialog', name: 'Order confirmed' }, state: 'visible' },
          { kind: 'console', level: 'error', absent: true },
          { kind: 'animation', name: 'dialog-in', completed: true },
        ],
      },
    })) as { pass: boolean; failureReason?: string };
    expect(verdict.pass, verdict.failureReason).toBe(true);
  });

  it('reports a failing assert with a reason', async () => {
    const verdict = (await callTool(deps, 'iris_assert', {
      predicate: { kind: 'route', pathname: '/success' },
    })) as { pass: boolean; failureReason?: string };
    expect(verdict.pass).toBe(false);
    expect(verdict.failureReason).toBeTruthy();
  });

  it('records a span and returns its reaction report', async () => {
    await callTool(deps, 'iris_record_start', { name: 'flow' });
    browser.emit(EventType.NET_REQUEST, { method: 'GET', url: '/api/x', status: 200 });
    await waitUntil(() => bridge.sessions.resolve('demo').eventsSince(0).length >= 4);
    const rec = (await callTool(deps, 'iris_record_stop', { name: 'flow' })) as {
      summary: { network: number };
    };
    expect(rec.summary.network).toBeGreaterThanOrEqual(1);
  });

  it('iris_state is registered and round-trips store + component state (G2)', async () => {
    const tool = TOOLS.find((t) => t.name === IrisTool.STATE);
    expect(tool).toBeDefined();
    expect(tool?.inputSchema['ref']).toBeDefined();
    expect(tool?.inputSchema['store']).toBeDefined();

    const result = (await callTool(deps, IrisTool.STATE, {
      store: 'workspace',
      ref: 'e7',
    })) as { stores: Record<string, unknown>; storeNames: string[]; component?: unknown };
    expect(result.storeNames).toContain('workspace');
    expect(result.stores['workspace']).toEqual({ tab: 'open' });
    expect(result.component).toEqual({ component: 'PayButton', hooks: [0] });
  });

  it('explore lists interactive elements with refs', async () => {
    const result = (await callTool(deps, 'iris_explore', {})) as {
      interactive: { ref: string }[];
    };
    expect(result.interactive.length).toBeGreaterThan(0);
    expect(result.interactive[0]?.ref).toMatch(/^e\d+$/);
  });
});

interface ActAndWaitResult {
  effect: { ok: boolean; ref?: string; action?: string };
  verdict: { pass: boolean; failureReason?: string };
  trace: { window_ms: number; summary: { network: number } };
}

describe('iris_act_and_wait (G3 composite)', () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let browser: FakeBrowser;

  beforeAll(async () => {
    bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    deps = {
      sessions: bridge.sessions,
      baselines: new BaselineStore(),
      recordings: new RecordingStore(),
    };
    browser = new FakeBrowser(port, 'demo');
    await browser.open();
    await waitUntil(() => bridge.sessions.count() === 1);
  });

  afterAll(async () => {
    browser.close();
    await bridge.close();
  });

  it('is registered with ref/action/until in its schema', () => {
    const tool = TOOLS.find((t) => t.name === 'iris_act_and_wait');
    expect(tool).toBeDefined();
    expect(tool?.inputSchema['ref']).toBeDefined();
    expect(tool?.inputSchema['action']).toBeDefined();
    expect(tool?.inputSchema['until']).toBeDefined();
  });

  it('acts and returns effect + passing verdict + trace when the predicate holds', async () => {
    browser.matcher = (q) => q.role === 'dialog' || (q.name ?? '').includes('Order confirmed');
    const result = (await callTool(deps, 'iris_act_and_wait', {
      ref: 'e7',
      action: 'click',
      timeout_ms: 1000,
      until: {
        kind: 'element',
        query: { role: 'dialog', name: 'Order confirmed' },
        state: 'visible',
      },
    })) as ActAndWaitResult;

    expect(result.effect.ok).toBe(true);
    expect(result.verdict.pass, result.verdict.failureReason).toBe(true);
    expect(result.trace).toBeDefined();
    expect(typeof result.trace.window_ms).toBe('number');
    browser.matcher = () => false;
  });

  it('captures post-act network events in the trace and passes on the late event', async () => {
    // Start the act-and-wait first; the predicate is NOT yet satisfiable.
    const pending = callTool(deps, 'iris_act_and_wait', {
      ref: 'e7',
      action: 'click',
      timeout_ms: 2000,
      until: { kind: 'net', method: 'POST', urlContains: '/api/order', status: 200 },
    }) as Promise<ActAndWaitResult>;

    // The app reacts after the act: the poll inside waitForPredicate catches it.
    browser.emit(EventType.NET_REQUEST, { method: 'POST', url: '/api/order', status: 200 });

    const result = await pending;
    expect(result.effect.ok).toBe(true);
    expect(result.verdict.pass, result.verdict.failureReason).toBe(true);
    expect(result.trace.summary.network).toBeGreaterThanOrEqual(1);
  });

  it('still returns effect + trace when the predicate times out', async () => {
    const result = (await callTool(deps, 'iris_act_and_wait', {
      ref: 'e7',
      action: 'click',
      timeout_ms: 200,
      until: { kind: 'route', pathname: '/never-happens' },
    })) as ActAndWaitResult;

    expect(result.effect.ok).toBe(true);
    expect(result.verdict.pass).toBe(false);
    expect(result.verdict.failureReason).toBeTruthy();
    expect(result.trace).toBeDefined();
  });

  it('evaluates the predicate once when timeout_ms is 0', async () => {
    browser.matcher = (q) => q.role === 'dialog' || (q.name ?? '').includes('Order confirmed');
    const result = (await callTool(deps, 'iris_act_and_wait', {
      ref: 'e7',
      action: 'click',
      timeout_ms: 0,
      until: {
        kind: 'element',
        query: { role: 'dialog', name: 'Order confirmed' },
        state: 'visible',
      },
    })) as ActAndWaitResult;

    expect(result.verdict.pass).toBe(true);
    browser.matcher = () => false;
  });
});
