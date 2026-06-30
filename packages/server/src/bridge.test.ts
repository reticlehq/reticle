import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventType, THROTTLED_WARNING } from '@reticlehq/protocol';
import { Bridge } from './bridge.js';
import { TOOLS, type ToolDeps } from './tools/tools.js';
import { ReticleTool } from './tools/tool-names.js';
import { FakeBrowser, callTool, makeDeps, waitUntil } from './bridge.test-harness.js';

describe('bridge round-trip (north-star)', () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let browser: FakeBrowser;

  beforeAll(async () => {
    bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    deps = makeDeps(bridge);
    browser = new FakeBrowser(port, 'demo', true);
    await browser.open();
    await waitUntil(() => bridge.sessions.count() === 1);
  });

  afterAll(async () => {
    browser.close();
    await bridge.close();
  });

  it('lists the connected session', async () => {
    const result = (await callTool(deps, 'reticle_sessions')) as { sessions: unknown[] };
    expect(result.sessions).toHaveLength(1);
  });

  it('advertises hasCapabilities from HELLO on the session', () => {
    const session = deps.sessions.list()[0] as { hasCapabilities?: boolean };
    expect(session.hasCapabilities).toBe(true);
  });

  it('reticle_capabilities returns the app-advertised testable surface', async () => {
    const tool = TOOLS.find((t) => t.name === ReticleTool.CAPABILITIES);
    expect(tool).toBeDefined();
    const result = (await callTool(deps, ReticleTool.CAPABILITIES, {})) as {
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

  it('reticle_capabilities propagates an unknown-command error from older browsers', async () => {
    browser.handlesCapabilities = false;
    await expect(callTool(deps, ReticleTool.CAPABILITIES, {})).rejects.toThrow(
      /unknown command 'capabilities'/,
    );
    browser.handlesCapabilities = true;
  });

  it('acts, observes the reaction, and asserts the full chain', async () => {
    // The agent clicks "Pay".
    const act = (await callTool(deps, 'reticle_act', { ref: 'e7', action: 'click' })) as {
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

    const observe = (await callTool(deps, 'reticle_observe', { since: act.since })) as {
      summary: { network: number; animations: number };
    };
    expect(observe.summary.network).toBe(1);
    expect(observe.summary.animations).toBe(1);

    const net = (await callTool(deps, 'reticle_network', { status: 200 })) as { calls: unknown[] };
    expect(net.calls).toHaveLength(1);

    // The single assert that covers the whole expectation.
    const verdict = (await callTool(deps, 'reticle_assert', {
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

  it('lifts dispatched/settled/settleReason to the reticle_act envelope', async () => {
    const act = (await callTool(deps, 'reticle_act', { ref: 'e7', action: 'click' })) as {
      dispatched: unknown;
      settled: unknown;
      settleReason: unknown;
    };
    expect(act.dispatched).toBe(true);
    expect(act.settled).toBe(true);
    expect(act.settleReason).toBe(null);
  });

  it('a settle timeout does NOT fail reticle_act — it resolves with settled:false', async () => {
    browser.actSettled = false;
    const act = (await callTool(deps, 'reticle_act', { ref: 'e7', action: 'click' })) as {
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
    const verdict = (await callTool(deps, 'reticle_assert', {
      predicate: { kind: 'route', pathname: '/success' },
    })) as { pass: boolean; failureReason?: string };
    expect(verdict.pass).toBe(false);
    expect(verdict.failureReason).toBeTruthy();
  });

  it('records a span and returns its reaction report', async () => {
    await callTool(deps, 'reticle_record_start', { recordingName: 'flow' });
    browser.emit(EventType.NET_REQUEST, { method: 'GET', url: '/api/x', status: 200 });
    await waitUntil(() => bridge.sessions.resolve('demo').eventsSince(0).length >= 4);
    const rec = (await callTool(deps, 'reticle_record_stop', { recordingName: 'flow' })) as {
      summary: { network: number };
    };
    expect(rec.summary.network).toBeGreaterThanOrEqual(1);
  });

  it('reticle_state is registered and round-trips store + component state', async () => {
    const tool = TOOLS.find((t) => t.name === ReticleTool.STATE);
    expect(tool).toBeDefined();
    expect(tool?.inputSchema['ref']).toBeDefined();
    expect(tool?.inputSchema['store']).toBeDefined();

    const result = (await callTool(deps, ReticleTool.STATE, {
      store: 'workspace',
      ref: 'e7',
    })) as { stores: Record<string, unknown>; storeNames: string[]; component?: unknown };
    expect(result.storeNames).toContain('workspace');
    expect(result.stores['workspace']).toEqual({ tab: 'open' });
    expect(result.component).toEqual({ component: 'PayButton', hooks: [0] });
  });

  it('explore lists interactive elements with refs', async () => {
    const result = (await callTool(deps, 'reticle_explore', {})) as {
      interactive: { ref: string }[];
    };
    expect(result.interactive.length).toBeGreaterThan(0);
    expect(result.interactive[0]?.ref).toMatch(/^e\d+$/);
  });

  it('a hidden session surfaces throttled:true + a warning on an reticle_act result', async () => {
    browser.emit(EventType.PAGE_HEALTH, {
      hidden: true,
      focused: false,
      reason: 'visibilitychange',
    });
    await waitUntil(() => bridge.sessions.resolve('demo').throttled());

    const act = (await callTool(deps, 'reticle_act', { ref: 'e7', action: 'click' })) as {
      session: { lastSeenMs: number; throttled: boolean; focused: boolean };
      warning?: string;
    };
    expect(act.session.throttled).toBe(true);
    expect(act.session.focused).toBe(false);
    expect(typeof act.session.lastSeenMs).toBe('number');
    expect(act.warning).toBe(THROTTLED_WARNING);
  });

  it('reticle_assert and reticle_act_and_wait carry the health envelope when throttled', async () => {
    browser.emit(EventType.PAGE_HEALTH, { hidden: true, focused: false, reason: 'blur' });
    await waitUntil(() => bridge.sessions.resolve('demo').throttled());

    const verdict = (await callTool(deps, 'reticle_assert', {
      predicate: { kind: 'console', level: 'error', absent: true },
    })) as { pass: boolean; session: { throttled: boolean }; warning?: string };
    expect(verdict.pass).toBe(true);
    expect(verdict.session.throttled).toBe(true);
    expect(verdict.warning).toBe(THROTTLED_WARNING);

    const aw = (await callTool(deps, 'reticle_act_and_wait', {
      ref: 'e7',
      action: 'click',
      timeout_ms: 0,
      until: { kind: 'console', level: 'error', absent: true },
    })) as { session: { throttled: boolean }; warning?: string };
    expect(aw.session.throttled).toBe(true);
    expect(aw.warning).toBe(THROTTLED_WARNING);
  });

  it('reticle_sessions surfaces hidden/focused/throttled', async () => {
    browser.emit(EventType.PAGE_HEALTH, { hidden: true, focused: false, reason: 'heartbeat' });
    await waitUntil(() => bridge.sessions.resolve('demo').throttled());
    const result = (await callTool(deps, 'reticle_sessions')) as {
      sessions: { hidden: boolean; focused: boolean; throttled: boolean }[];
    };
    const entry = result.sessions[0];
    expect(entry?.hidden).toBe(true);
    expect(entry?.focused).toBe(false);
    expect(entry?.throttled).toBe(true);
  });

  it('a visible session has no warning and throttled:false', async () => {
    browser.emit(EventType.PAGE_HEALTH, { hidden: false, focused: true, reason: 'focus' });
    await waitUntil(() => !bridge.sessions.resolve('demo').throttled());
    const act = (await callTool(deps, 'reticle_act', { ref: 'e7', action: 'click' })) as {
      session?: { throttled: boolean; focused: boolean };
      warning?: string;
    };
    // Nominal session → health block omitted entirely (absence means healthy); no warning.
    expect(act.session).toBeUndefined();
    expect(act.warning).toBeUndefined();
  });

  it('refuseWhenThrottled is opt-in — rejects only with the flag', async () => {
    browser.emit(EventType.PAGE_HEALTH, { hidden: true, focused: false, reason: 'blur' });
    await waitUntil(() => bridge.sessions.resolve('demo').throttled());

    // Default (warn-only) still resolves so background testing is never broken.
    await expect(
      callTool(deps, 'reticle_act', { ref: 'e7', action: 'click' }),
    ).resolves.toBeDefined();
    // Opt-in flag hard-fails.
    await expect(
      callTool(deps, 'reticle_act', { ref: 'e7', action: 'click', refuseWhenThrottled: true }),
    ).rejects.toThrow(/refusing to act/);

    // Restore a healthy state for any later shared assertions.
    browser.emit(EventType.PAGE_HEALTH, { hidden: false, focused: true, reason: 'focus' });
    await waitUntil(() => !bridge.sessions.resolve('demo').throttled());
  });
});
