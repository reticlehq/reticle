import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventType } from '@reticle/protocol';
import { Bridge } from './bridge.js';
import { TOOLS, type ToolDeps } from './tools/tools.js';
import { FakeBrowser, callTool, makeDeps, waitUntil } from './bridge.test-harness.js';

interface ActAndWaitResult {
  effect: { ok: boolean; ref?: string; action?: string };
  verdict: { pass: boolean; failureReason?: string };
  trace: { window_ms: number; summary: { network: number } };
}

describe('reticle_act_and_wait (composite)', () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let browser: FakeBrowser;

  beforeAll(async () => {
    bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    deps = makeDeps(bridge);
    browser = new FakeBrowser(port, 'demo');
    await browser.open();
    await waitUntil(() => bridge.sessions.count() === 1);
  });

  afterAll(async () => {
    browser.close();
    await bridge.close();
  });

  it('is registered with ref/action/until in its schema', () => {
    const tool = TOOLS.find((t) => t.name === 'reticle_act_and_wait');
    expect(tool).toBeDefined();
    expect(tool?.inputSchema['ref']).toBeDefined();
    expect(tool?.inputSchema['action']).toBeDefined();
    expect(tool?.inputSchema['until']).toBeDefined();
  });

  it('acts and returns effect + passing verdict + trace when the predicate holds', async () => {
    browser.matcher = (q) => q.role === 'dialog' || (q.name ?? '').includes('Order confirmed');
    const result = (await callTool(deps, 'reticle_act_and_wait', {
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
    const pending = callTool(deps, 'reticle_act_and_wait', {
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
    const result = (await callTool(deps, 'reticle_act_and_wait', {
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
    const result = (await callTool(deps, 'reticle_act_and_wait', {
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
