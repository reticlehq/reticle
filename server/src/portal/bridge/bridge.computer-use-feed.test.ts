import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RETICLE_WS_PATH, LOOPBACK_HOST } from '@reticlehq/core';
import { UiRole, connectPeer } from '@reticlehq/computer-use';
import type { Peer, UiDriver, UiNode, UiRead } from '@reticlehq/computer-use';
import { Bridge } from './bridge.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { callTool, makeDeps, waitUntil } from './bridge.test-harness.js';

/**
 * A feed in a browser that gives no scroll bar: each End key shows the next three posts. An
 * agent that is told to keep scrolling must not pay one turn of the model for each scroll.
 */
function node(role: UiRole, name: string, more: Partial<UiNode> = {}): UiNode {
  return { role, name, states: [], children: [], ...more };
}

class Feed implements UiDriver {
  first = 1;
  readonly keys: string[] = [];

  subject(): { app: string; pid: number } {
    return { app: 'Google Chrome', pid: 7 };
  }

  #now(): UiRead {
    const posts = [0, 1, 2].map((at) =>
      node(UiRole.TEXT, `Post ${String(this.first + at)}`, { frame: [10, 40 + 80 * at, 100, 30] }),
    );
    const root = node(UiRole.WINDOW, 'Feed - Google Chrome', {
      frame: [0, 0, 400, 300],
      children: [node(UiRole.DOCUMENT, 'Feed', { frame: [0, 0, 400, 300], children: posts })],
    });
    return { root, unread: 0, unmapped: [] };
  }

  read(): Promise<UiRead> {
    return Promise.resolve(this.#now());
  }

  reach() {
    return Promise.resolve({ reach: 'yes' as const });
  }

  act(request: Parameters<UiDriver['act']>[0]) {
    const before = this.#now();
    this.keys.push(request.value ?? '');
    this.first += 3;
    return Promise.resolve({
      delivered: true,
      reachable: true,
      settled: true,
      before,
      after: this.#now(),
    });
  }
}

describe('a feed with no scroll bar', () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let peer: Peer;
  const feed = new Feed();

  beforeAll(async () => {
    bridge = new Bridge({ port: 0, token: 'feed-test-token' });
    const port = await bridge.ready;
    deps = makeDeps(bridge);
    peer = connectPeer({
      url: `ws://${LOOPBACK_HOST}:${String(port)}${RETICLE_WS_PATH}`,
      token: 'feed-test-token',
      sessionId: 'cu-feed',
      projectId: 'cu-feed',
      driver: feed,
      now: () => Date.now(),
    });
    await peer.ready;
    await waitUntil(() => 1 === bridge.sessions.count());
  });

  afterAll(async () => {
    peer.close();
    await bridge.close();
  });

  it('is scrolled three times in one call, and the page then shows the posts that came', async () => {
    const scroll = {
      target: { role: 'document', name: 'Feed' },
      action: 'scroll',
      args: { fraction: 1 },
    };
    const out = (await callTool(deps, 'reticle_act_sequence', {
      steps: [scroll, scroll, scroll],
    })) as Record<string, unknown>;
    expect(feed.keys).toEqual(['End', 'End', 'End']);
    const page = (await callTool(deps, 'reticle_snapshot', {})) as { tree: string };
    expect(page.tree).toContain('Post 10');
    expect(out['completed']).toBe(3);
  });
});
