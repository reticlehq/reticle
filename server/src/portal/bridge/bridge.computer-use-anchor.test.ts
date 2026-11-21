import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ElementState, RETICLE_WS_PATH, LOOPBACK_HOST } from '@reticlehq/core';
import { UiRole, connectPeer } from '@reticlehq/computer-use';
import type { Peer, UiDriver, UiNode, UiRead } from '@reticlehq/computer-use';
import { Bridge } from './bridge.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { callTool, makeDeps, waitUntil } from './bridge.test-harness.js';

/**
 * A list where each row has a button with the same name. A saved step that names the button by
 * its role and its name cannot say which row it meant, and a replay refuses to guess. When the
 * application gives each button an identifier, the step is saved by it, and the replay presses
 * the button of the same row.
 */
function node(role: UiRole, name: string, more: Partial<UiNode> = {}): UiNode {
  return { role, name, states: [], children: [], ...more };
}

class Rows implements UiDriver {
  rows = ['alpha', 'beta'];
  withIds = true;
  readonly deleted: string[] = [];

  subject(): { app: string; pid: number } {
    return { app: 'Notes', pid: 7 };
  }

  #now(): UiRead {
    const root = node(UiRole.WINDOW, 'Notes', {
      frame: [0, 0, 400, 300],
      children: this.rows.map((row, at) =>
        node(UiRole.GROUP, '', {
          frame: [0, 40 * at, 400, 40],
          children: [
            node(UiRole.TEXT, row, { frame: [10, 40 * at, 100, 30] }),
            node(UiRole.BUTTON, 'Delete', {
              frame: [200, 40 * at, 80, 30],
              ...(this.withIds ? { id: `delete-${row}` } : {}),
            }),
          ],
        }),
      ),
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
    const row = this.rows[request.target.path[0] ?? -1] ?? '';
    this.deleted.push(row);
    this.rows = this.rows.filter((other) => other !== row);
    return Promise.resolve({
      delivered: true,
      reachable: true,
      settled: true,
      before,
      after: this.#now(),
    });
  }
}

describe('a saved step on a list of rows with the same button', () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let peer: Peer;
  const app = new Rows();

  beforeAll(async () => {
    bridge = new Bridge({ port: 0, token: 'anchor-test-token' });
    const port = await bridge.ready;
    deps = makeDeps(bridge);
    peer = connectPeer({
      url: `ws://${LOOPBACK_HOST}:${String(port)}${RETICLE_WS_PATH}`,
      token: 'anchor-test-token',
      sessionId: 'cu-rows',
      projectId: 'rows-app',
      driver: app,
      now: () => Date.now(),
    });
    await peer.ready;
    await waitUntil(() => 1 === bridge.sessions.count());
  });

  afterAll(async () => {
    peer.close();
    await bridge.close();
  });

  const recordDeleteOfBeta = async (): Promise<string> => {
    app.rows = ['alpha', 'beta'];
    const page = (await callTool(deps, 'reticle_snapshot', {})) as { tree: string };
    const refs = [...page.tree.matchAll(/button "Delete" \(ref=(e\d+)\)/g)].map((m) => m[1]);
    await callTool(deps, 'reticle_record', { action: 'start' });
    await callTool(deps, 'reticle_act_and_wait', {
      ref: refs[1],
      action: 'click',
      timeout_ms: 1000,
      until: { kind: 'element', query: { text: 'alpha' }, state: ElementState.VISIBLE },
    });
    const recorded = (await callTool(deps, 'reticle_record', { action: 'stop' })) as {
      recordingName: string;
    };
    await callTool(deps, 'reticle_flow_save', { flowName: recorded.recordingName });
    app.rows = ['alpha', 'beta'];
    app.deleted.length = 0;
    return recorded.recordingName;
  };

  it('presses the button of the same row, when the buttons have identifiers', async () => {
    app.withIds = true;
    const flowName = await recordDeleteOfBeta();
    const replayed = (await callTool(deps, 'reticle_flow_replay', { flowName })) as {
      status: string;
    };
    expect(replayed.status).toBe('ok');
    expect(app.deleted).toEqual(['beta']);
  }, 30_000);

  it('refuses to guess, and presses nothing, when they have none', async () => {
    app.withIds = false;
    const flowName = await recordDeleteOfBeta();
    const replayed = (await callTool(deps, 'reticle_flow_replay', { flowName })) as {
      status: string;
    };
    expect(replayed.status).not.toBe('ok');
    expect(app.deleted).toEqual([]);
  }, 30_000);
});
