import { describe, expect, it } from 'vitest';
import { LOOPBACK_HOST, RETICLE_WS_PATH } from '@reticlehq/core';
import { UiRole, connectPeer } from '@reticlehq/computer-use';
import type { UiDriver, UiNode, UiRead } from '@reticlehq/computer-use';
import { Bridge } from './bridge.js';
import { callTool, makeDeps, waitUntil } from './bridge.test-harness.js';

/**
 * The daemon ends when it is idle and starts again on the next tool call. A computer-use peer that
 * stayed gone after that made the application disappear for the agent, with no word. The peer
 * dials again, and a ref that the agent holds is still the same element.
 */
function node(role: UiRole, name: string, children: UiNode[] = []): UiNode {
  return { role, name, states: [], frame: [0, 0, 100, 30], children };
}

const pressed: string[] = [];
const app: UiDriver = {
  subject: () => ({ app: 'Notes', pid: 7 }),
  read: (): Promise<UiRead> =>
    Promise.resolve({
      root: node(UiRole.WINDOW, 'Notes', [node(UiRole.BUTTON, 'Save')]),
      unread: 0,
      unmapped: [],
    }),
  reach: () => Promise.resolve({ reach: 'yes' as const }),
  act: async (request) => {
    pressed.push(request.target.node.name);
    const read = await app.read();
    return { delivered: true, reachable: true, settled: true, before: read, after: read };
  },
};

describe('a computer-use peer when the bridge goes away', () => {
  it('joins the next bridge on the same port, with the refs it gave before', async () => {
    const first = new Bridge({ port: 0 });
    const port = await first.ready;
    const peer = connectPeer({
      url: `ws://${LOOPBACK_HOST}:${String(port)}${RETICLE_WS_PATH}`,
      sessionId: 'cu-notes',
      projectId: 'notes-app',
      driver: app,
      retryMs: 50,
      now: () => Date.now(),
    });
    await peer.ready;
    await waitUntil(() => 1 === first.sessions.count());
    const before = (await callTool(makeDeps(first), 'reticle_snapshot', {})) as { tree: string };
    const save = /button "Save" \(ref=(e\d+)\)/.exec(before.tree)?.[1] ?? '';
    expect(save).not.toBe('');

    await first.close();
    const second = new Bridge({ port });
    await second.ready;
    await waitUntil(() => 1 === second.sessions.count());

    await callTool(makeDeps(second), 'reticle_act', { ref: save, action: 'click' });
    expect(pressed).toEqual(['Save']);

    // A peer that was closed on purpose stays closed.
    peer.close();
    await waitUntil(() => 0 === second.sessions.count());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(second.sessions.count()).toBe(0);
    await second.close();
  }, 30_000);
});
