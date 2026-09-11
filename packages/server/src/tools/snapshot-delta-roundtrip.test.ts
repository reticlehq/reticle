import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Bridge } from '../bridge/bridge.js';
import type { ToolDeps } from './tools.js';
import { FakeBrowser, callTool, makeDeps, waitUntil } from '../bridge/bridge.test-harness.js';
import { SnapshotDeltaMode } from './snapshot-delta.js';

describe('reticle_snapshot diff round trip — fields survive the tool boundary', () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let browser: FakeBrowser;

  beforeAll(async () => {
    bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    deps = makeDeps(bridge);
    browser = new FakeBrowser(port, 'delta-rt');
    await browser.open();
    await waitUntil(() => 1 === bridge.sessions.count());
  });

  afterAll(async () => {
    browser.close();
    await bridge.close();
  });

  it('first diff call returns mode "full" with a reason', async () => {
    browser.snapshotResult = {
      tree: '- textbox "Search" (ref=e1)',
      status: { route: '/home' },
    };
    const out = (await callTool(deps, 'reticle_snapshot', { diff: true })) as Record<
      string,
      unknown
    >;
    expect(out['mode']).toBe(SnapshotDeltaMode.FULL);
    expect(out['reason']).toBe('first snapshot for this route');
  });

  it('a value change surfaces changed and changedCount at top level', async () => {
    browser.snapshotResult = {
      tree: '- textbox "Search" (ref=e1) [value="hello"]',
      status: { route: '/home' },
    };
    const out = (await callTool(deps, 'reticle_snapshot', { diff: true })) as Record<
      string,
      unknown
    >;
    expect(out['mode']).toBe(SnapshotDeltaMode.DELTA);
    expect(out['changed']).toEqual(['- textbox "Search" (ref=e1) [value="hello"]']);
    expect(out['changedCount']).toBe(1);
    const delta = out['delta'] as Record<string, unknown> | undefined;
    expect(delta).toBeDefined();
    if (delta !== undefined) {
      expect(delta['changedCount']).toBeUndefined();
    }
  });

  it('unchanged tree returns mode "unchanged"', async () => {
    const out = (await callTool(deps, 'reticle_snapshot', { diff: true })) as Record<
      string,
      unknown
    >;
    expect(out['mode']).toBe(SnapshotDeltaMode.UNCHANGED);
  });
});
