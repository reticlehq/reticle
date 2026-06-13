import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import {
  EventType,
  IRIS_WS_PATH,
  IrisCommand,
  MessageKind,
  THROTTLED_WARNING,
  type ElementQuery,
} from '@syrin/iris-protocol';
import { Bridge } from './bridge.js';
import { BaselineStore } from './baselines.js';
import { createNodeFileSystem } from './fs-port.js';
import { RecordingStore } from './recordings.js';
import { FlowStore } from './flows.js';
import { ProjectStore } from './project-store.js';
import { AnnotationStore } from './annotation-store.js';
import { TOOLS, type ToolDeps } from './tools.js';
import { IrisTool } from './tool-names.js';

/** A stand-in for the real @syrin/iris-browser SDK: replies to commands and emits events. */
const FAKE_CAPABILITIES = {
  testids: ['toast'],
  signals: ['webhook:received'],
  stores: ['cart'],
  flows: [{ name: 'pay', steps: ['fill', 'click'] }],
};

class FakeBrowser {
  readonly #ws: WebSocket;
  matcher: (query: ElementQuery) => boolean = () => false;
  /** When false, the browser pretends it has no CAPABILITIES handler (older build). */
  handlesCapabilities = true;
  /** When false, ACT results omit a testid (element has no data-testid → unstable step). */
  actHasTestid = true;
  /** F1: when false, ACT reports settled:false + settleReason:'timeout' (throttled-tab path). */
  actSettled = true;
  /** When false, QUERY by testid returns no match (testid not in current DOM at replay). */
  queryResolves = true;
  /** Records every command the bridge sent (for replay assertions). */
  readonly received: { name: string; args: Record<string, unknown> }[] = [];

  constructor(
    port: number,
    private readonly sessionId: string,
    private readonly hasCapabilities = false,
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
          hasCapabilities: this.hasCapabilities,
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
    this.received.push({ name, args });
    let result: unknown = { ok: true };
    if (name === IrisCommand.ACT) {
      result = {
        ok: true,
        ref: args['ref'],
        action: args['action'],
        dispatched: true,
        settled: this.actSettled,
        settleReason: this.actSettled ? null : 'timeout',
        effect: { dispatched: true },
        ...(this.actHasTestid ? { testid: 'pay-btn' } : {}),
      };
    } else if (name === IrisCommand.ACT_SEQUENCE) {
      const steps = (Array.isArray(args['steps']) ? args['steps'] : []) as Record<
        string,
        unknown
      >[];
      result = {
        count: steps.length,
        steps: steps.map((s) => ({
          ref: s['ref'],
          action: s['action'],
          ...(this.actHasTestid ? { testid: 'pay-btn' } : {}),
        })),
      };
    } else if (name === IrisCommand.QUERY) {
      result = {
        elements: this.queryResolves
          ? [{ ref: 'e7', role: 'button', name: 'Pay', states: [], visible: true }]
          : [],
      };
    } else if (name === IrisCommand.MATCH) {
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
    } else if (name === IrisCommand.CAPABILITIES) {
      if (!this.handlesCapabilities) {
        this.#send({
          kind: MessageKind.COMMAND_RESULT,
          id,
          ok: false,
          error: `unknown command '${name}'`,
        });
        return;
      }
      result = FAKE_CAPABILITIES;
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
      flows: new FlowStore(createNodeFileSystem(), '/tmp/iris-test/.iris', { now: () => 0 }),
      project: new ProjectStore(createNodeFileSystem(), '/tmp/iris-test/.iris', { now: () => 0 }),
      annotations: new AnnotationStore(),
      fs: createNodeFileSystem(),
      irisRoot: '/tmp/iris-test/.iris',
      now: () => 0,
    };
    browser = new FakeBrowser(port, 'demo', true);
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

  it('advertises hasCapabilities from HELLO on the session (G5)', () => {
    const session = deps.sessions.list()[0] as { hasCapabilities?: boolean };
    expect(session.hasCapabilities).toBe(true);
  });

  it('iris_capabilities returns the app-advertised testable surface (G5)', async () => {
    const tool = TOOLS.find((t) => t.name === IrisTool.CAPABILITIES);
    expect(tool).toBeDefined();
    const result = (await callTool(deps, IrisTool.CAPABILITIES, {})) as {
      testids: string[];
      signals: string[];
      stores: string[];
      flows: { name: string; steps: string[] }[];
    };
    expect(result.testids).toEqual(['toast']);
    expect(result.signals).toEqual(['webhook:received']);
    expect(result.stores).toEqual(['cart']);
    expect(result.flows).toEqual([{ name: 'pay', steps: ['fill', 'click'] }]);
  });

  it('iris_capabilities propagates an unknown-command error from older browsers (G5)', async () => {
    browser.handlesCapabilities = false;
    await expect(callTool(deps, IrisTool.CAPABILITIES, {})).rejects.toThrow(
      /unknown command 'capabilities'/,
    );
    browser.handlesCapabilities = true;
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

  it('F1: lifts dispatched/settled/settleReason to the iris_act envelope', async () => {
    const act = (await callTool(deps, 'iris_act', { ref: 'e7', action: 'click' })) as {
      dispatched: unknown;
      settled: unknown;
      settleReason: unknown;
    };
    expect(act.dispatched).toBe(true);
    expect(act.settled).toBe(true);
    expect(act.settleReason).toBe(null);
  });

  it('F1: a settle timeout does NOT fail iris_act — it resolves with settled:false', async () => {
    browser.actSettled = false;
    const act = (await callTool(deps, 'iris_act', { ref: 'e7', action: 'click' })) as {
      dispatched: unknown;
      settled: unknown;
      settleReason: unknown;
    };
    expect(act.dispatched).toBe(true);
    expect(act.settled).toBe(false);
    expect(act.settleReason).toBe('timeout');
    browser.actSettled = true;
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

  it('F2: a hidden session surfaces throttled:true + a warning on an iris_act result', async () => {
    browser.emit(EventType.PAGE_HEALTH, {
      hidden: true,
      focused: false,
      reason: 'visibilitychange',
    });
    await waitUntil(() => bridge.sessions.resolve('demo').throttled());

    const act = (await callTool(deps, 'iris_act', { ref: 'e7', action: 'click' })) as {
      session: { lastSeenMs: number; throttled: boolean; focused: boolean };
      warning?: string;
    };
    expect(act.session.throttled).toBe(true);
    expect(act.session.focused).toBe(false);
    expect(typeof act.session.lastSeenMs).toBe('number');
    expect(act.warning).toBe(THROTTLED_WARNING);
  });

  it('F2: iris_assert and iris_act_and_wait carry the health envelope when throttled', async () => {
    browser.emit(EventType.PAGE_HEALTH, { hidden: true, focused: false, reason: 'blur' });
    await waitUntil(() => bridge.sessions.resolve('demo').throttled());

    const verdict = (await callTool(deps, 'iris_assert', {
      predicate: { kind: 'console', level: 'error', absent: true },
    })) as { pass: boolean; session: { throttled: boolean }; warning?: string };
    expect(verdict.pass).toBe(true);
    expect(verdict.session.throttled).toBe(true);
    expect(verdict.warning).toBe(THROTTLED_WARNING);

    const aw = (await callTool(deps, 'iris_act_and_wait', {
      ref: 'e7',
      action: 'click',
      timeout_ms: 0,
      until: { kind: 'console', level: 'error', absent: true },
    })) as { session: { throttled: boolean }; warning?: string };
    expect(aw.session.throttled).toBe(true);
    expect(aw.warning).toBe(THROTTLED_WARNING);
  });

  it('F2: iris_sessions surfaces hidden/focused/throttled', async () => {
    browser.emit(EventType.PAGE_HEALTH, { hidden: true, focused: false, reason: 'heartbeat' });
    await waitUntil(() => bridge.sessions.resolve('demo').throttled());
    const result = (await callTool(deps, 'iris_sessions')) as {
      sessions: { hidden: boolean; focused: boolean; throttled: boolean }[];
    };
    const entry = result.sessions[0];
    expect(entry?.hidden).toBe(true);
    expect(entry?.focused).toBe(false);
    expect(entry?.throttled).toBe(true);
  });

  it('F2: a visible session has no warning and throttled:false', async () => {
    browser.emit(EventType.PAGE_HEALTH, { hidden: false, focused: true, reason: 'focus' });
    await waitUntil(() => !bridge.sessions.resolve('demo').throttled());
    const act = (await callTool(deps, 'iris_act', { ref: 'e7', action: 'click' })) as {
      session: { throttled: boolean; focused: boolean };
      warning?: string;
    };
    expect(act.session.throttled).toBe(false);
    expect(act.session.focused).toBe(true);
    expect(act.warning).toBeUndefined();
  });

  it('F2: refuseWhenThrottled is opt-in — rejects only with the flag', async () => {
    browser.emit(EventType.PAGE_HEALTH, { hidden: true, focused: false, reason: 'blur' });
    await waitUntil(() => bridge.sessions.resolve('demo').throttled());

    // Default (warn-only) still resolves so background testing is never broken.
    await expect(callTool(deps, 'iris_act', { ref: 'e7', action: 'click' })).resolves.toBeDefined();
    // Opt-in flag hard-fails.
    await expect(
      callTool(deps, 'iris_act', { ref: 'e7', action: 'click', refuseWhenThrottled: true }),
    ).rejects.toThrow(/refusing to act/);

    // Restore a healthy state for any later shared assertions.
    browser.emit(EventType.PAGE_HEALTH, { hidden: false, focused: true, reason: 'focus' });
    await waitUntil(() => !bridge.sessions.resolve('demo').throttled());
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
      flows: new FlowStore(createNodeFileSystem(), '/tmp/iris-test/.iris', { now: () => 0 }),
      project: new ProjectStore(createNodeFileSystem(), '/tmp/iris-test/.iris', { now: () => 0 }),
      annotations: new AnnotationStore(),
      fs: createNodeFileSystem(),
      irisRoot: '/tmp/iris-test/.iris',
      now: () => 0,
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

interface CompiledStep {
  tool: string;
  stable: boolean;
  args: Record<string, unknown>;
}
interface RecordStopResult {
  name: string;
  program: { version: number; steps: CompiledStep[] };
  warning?: string;
  summary: { network: number };
}
interface ReplayResult {
  name: string;
  ok: boolean;
  steps: { tool: string; ok: boolean; error?: string; note?: string }[];
}

describe('G6 record -> compile -> replay', () => {
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
      flows: new FlowStore(createNodeFileSystem(), '/tmp/iris-test/.iris', { now: () => 0 }),
      project: new ProjectStore(createNodeFileSystem(), '/tmp/iris-test/.iris', { now: () => 0 }),
      annotations: new AnnotationStore(),
      fs: createNodeFileSystem(),
      irisRoot: '/tmp/iris-test/.iris',
      now: () => 0,
    };
    browser = new FakeBrowser(port, 'demo');
    await browser.open();
    await waitUntil(() => bridge.sessions.count() === 1);
  });

  afterAll(async () => {
    browser.close();
    await bridge.close();
  });

  it('iris_replay is registered with name in its schema', () => {
    const tool = TOOLS.find((t) => t.name === IrisTool.REPLAY);
    expect(tool).toBeDefined();
    expect(tool?.inputSchema['name']).toBeDefined();
  });

  it('compiles a testid-bound program (stable) and keeps the reaction report', async () => {
    browser.actHasTestid = true;
    await callTool(deps, IrisTool.RECORD_START, { name: 'flow' });
    await callTool(deps, IrisTool.ACT, { ref: 'e7', action: 'click' });
    browser.emit(EventType.NET_REQUEST, { method: 'POST', url: '/api/order', status: 200 });
    await waitUntil(() => bridge.sessions.resolve('demo').eventsSince(0).length >= 1);
    const rec = (await callTool(deps, IrisTool.RECORD_STOP, { name: 'flow' })) as RecordStopResult;
    expect(rec.program.version).toBe(1);
    expect(rec.program.steps).toHaveLength(1);
    expect(rec.program.steps[0]).toEqual({
      tool: 'iris_act',
      stable: true,
      args: { by: 'testid', value: 'pay-btn', action: 'click', args: {} },
    });
    expect(rec.warning).toBeUndefined();
    expect(rec.summary.network).toBeGreaterThanOrEqual(1);
  });

  it('flags steps with no testid as unstable and warns', async () => {
    browser.actHasTestid = false;
    await callTool(deps, IrisTool.RECORD_START, { name: 'noid' });
    await callTool(deps, IrisTool.ACT, { ref: 'e7', action: 'click' });
    const rec = (await callTool(deps, IrisTool.RECORD_STOP, { name: 'noid' })) as RecordStopResult;
    expect(rec.program.steps[0]?.stable).toBe(false);
    expect(rec.program.steps[0]?.args).toEqual({ ref: 'e7', action: 'click', args: {} });
    expect(rec.warning).toMatch(/not bound to a testid/);
    browser.actHasTestid = true;
  });

  it('replay re-resolves by testid and re-runs each step', async () => {
    await callTool(deps, IrisTool.RECORD_START, { name: 'rerun' });
    await callTool(deps, IrisTool.ACT, { ref: 'e7', action: 'click' });
    await callTool(deps, IrisTool.RECORD_STOP, { name: 'rerun' });

    browser.received.length = 0;
    const replay = (await callTool(deps, IrisTool.REPLAY, { name: 'rerun' })) as ReplayResult;
    expect(replay.ok).toBe(true);
    expect(replay.steps).toEqual([{ tool: 'iris_act', ok: true }]);
    const query = browser.received.find((c) => c.name === IrisCommand.QUERY);
    expect(query?.args).toMatchObject({ by: 'testid', value: 'pay-btn' });
    const act = browser.received.find((c) => c.name === IrisCommand.ACT);
    expect(act?.args).toMatchObject({ ref: 'e7', action: 'click' });
  });

  it('replay of an unknown program throws', async () => {
    await expect(callTool(deps, IrisTool.REPLAY, { name: 'nope' })).rejects.toThrow(
      /no compiled recording named 'nope'/,
    );
  });

  it('replay stops with ok:false when a testid does not resolve', async () => {
    await callTool(deps, IrisTool.RECORD_START, { name: 'gone' });
    await callTool(deps, IrisTool.ACT, { ref: 'e7', action: 'click' });
    await callTool(deps, IrisTool.RECORD_STOP, { name: 'gone' });

    browser.queryResolves = false;
    const replay = (await callTool(deps, IrisTool.REPLAY, { name: 'gone' })) as ReplayResult;
    expect(replay.ok).toBe(false);
    expect(replay.steps[0]?.ok).toBe(false);
    expect(replay.steps[0]?.error).toMatch(/did not resolve/);
    browser.queryResolves = true;
  });

  it('captures and replays an act_sequence step', async () => {
    await callTool(deps, IrisTool.RECORD_START, { name: 'seq' });
    await callTool(deps, IrisTool.ACT_SEQUENCE, {
      steps: [{ ref: 'e7', action: 'click' }],
    });
    const rec = (await callTool(deps, IrisTool.RECORD_STOP, { name: 'seq' })) as RecordStopResult;
    expect(rec.program.steps[0]?.tool).toBe('iris_act_sequence');
    expect(rec.program.steps[0]?.stable).toBe(true);

    browser.received.length = 0;
    const replay = (await callTool(deps, IrisTool.REPLAY, { name: 'seq' })) as ReplayResult;
    expect(replay.ok).toBe(true);
    expect(replay.steps[0]?.tool).toBe('iris_act_sequence');
    const seqCmd = browser.received.find((c) => c.name === IrisCommand.ACT_SEQUENCE);
    expect(seqCmd).toBeDefined();
  });
});
