import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RETICLE_WS_PATH, LOOPBACK_HOST, ReticleTool } from '@reticlehq/core';
import { UiRole, connectPeer } from '@reticlehq/computer-use';
import type { Peer, UiDriver, UiNode, UiRead } from '@reticlehq/computer-use';
import { Bridge } from './bridge.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { callTool, FakeBrowser, makeDeps, waitUntil } from './bridge.test-harness.js';

/**
 * A browser on the desktop shows a page that has the SDK in it. Both are connected: the browser
 * through the operating system, the page from inside. The session list must say that they are
 * the same page, through the real bridge and the real peer, and not through a stand-in for them.
 */
function node(role: UiRole, name: string, more: Partial<UiNode> = {}): UiNode {
  return { role, name, states: [], children: [], ...more };
}

const TOKEN = 'realms-test-token';

/** A browser with one window. The fake page of the harness has the title "Checkout". */
const chrome: UiDriver = {
  subject: () => ({ app: 'Google Chrome', pid: 7 }),
  read: (): Promise<UiRead> =>
    Promise.resolve({
      root: node(UiRole.APPLICATION, 'Google Chrome', {
        children: [node(UiRole.WINDOW, 'Checkout - Google Chrome', { frame: [0, 0, 800, 600] })],
      }),
      unread: 0,
      unmapped: [],
    }),
  reach: () => Promise.resolve({ reach: 'yes' as const }),
  act: () => Promise.reject(new Error('this test does no action')),
};

describe('a desktop browser and the page inside it, both connected', () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let peer: Peer;

  beforeAll(async () => {
    bridge = new Bridge({ port: 0, token: TOKEN });
    const port = await bridge.ready;
    deps = makeDeps(bridge);
    await new FakeBrowser(port, 'tab-checkout', false, TOKEN).open();
    peer = connectPeer({
      url: `ws://${LOOPBACK_HOST}:${String(port)}${RETICLE_WS_PATH}`,
      token: TOKEN,
      sessionId: 'cu-chrome',
      projectId: 'cu-chrome',
      driver: chrome,
      now: () => Date.now(),
    });
    await peer.ready;
    await waitUntil(() => 2 === bridge.sessions.count());
  });

  afterAll(async () => {
    peer.close();
    await bridge.close();
  });

  it('names each kind of session, and the window that shows the page', async () => {
    const listed = (await callTool(deps, ReticleTool.SESSIONS, {})) as {
      realms?: { desktop: string[]; insideTheApp: string[]; samePage?: unknown[] };
    };
    expect(listed.realms?.desktop).toEqual(['cu-chrome']);
    expect(listed.realms?.insideTheApp).toEqual(['tab-checkout']);
    expect(listed.realms?.samePage).toEqual([
      { desktop: 'cu-chrome', insideTheApp: 'tab-checkout', window: 'Checkout - Google Chrome' },
    ]);
  });
});
