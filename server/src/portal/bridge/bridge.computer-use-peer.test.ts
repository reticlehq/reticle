import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ElementState, RETICLE_WS_PATH, LOOPBACK_HOST } from '@reticlehq/core';
import { UiRole, connectPeer } from '@reticlehq/computer-use';
import type { ActRequest, Peer, UiDriver, UiNode, UiRead } from '@reticlehq/computer-use';
import { Bridge } from './bridge.js';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { callTool, makeDeps, waitUntil } from './bridge.test-harness.js';

/**
 * A desktop application reaches the same tools as a web page, with no change in the server: the
 * computer-use realm joins the bridge as a peer. The application here is not a real one. It has a
 * Save button that changes the status text, and a Dead button that changes nothing.
 */
function node(role: UiRole, name: string, more: Partial<UiNode> = {}): UiNode {
  return { role, name, states: [], children: [], ...more };
}

class FakeApp implements UiDriver {
  status = 'Ready';
  readonly pressed: string[] = [];
  readonly files = new Map<
    string,
    { hash: string; size: number; mode: number; linkTo: undefined }
  >();

  subject(): { app: string; pid: number } {
    return { app: 'Notes', pid: 7 };
  }

  #now(): UiRead {
    const root = node(UiRole.WINDOW, 'Notes', {
      frame: [0, 0, 400, 300],
      children: [
        node(UiRole.BUTTON, 'Save', { frame: [10, 10, 80, 30] }),
        node(UiRole.BUTTON, 'Dead', { frame: [100, 10, 80, 30] }),
        node(UiRole.BUTTON, 'Export', { frame: [10, 50, 80, 30] }),
        node(UiRole.BUTTON, 'Fake', { frame: [100, 50, 80, 30] }),
        node(UiRole.TEXT, this.status, { frame: [10, 90, 200, 20] }),
      ],
    });
    return { root, unread: 0, unmapped: [] };
  }

  read(): Promise<UiRead> {
    return Promise.resolve(this.#now());
  }

  /** True while a window of another application is over this one. */
  covered = false;

  reach() {
    return Promise.resolve(
      this.covered
        ? { reach: 'no' as const, detail: 'window "Mail" of Mail' }
        : { reach: 'yes' as const },
    );
  }

  act(request: ActRequest) {
    const before = this.#now();
    this.pressed.push(request.target.node.name);
    if ('Save' === request.target.node.name) {
      this.status = 'Saved';
    }
    // Both say "Exported". Only Export writes the file.
    if ('Export' === request.target.node.name) {
      this.files.set('/out/note.txt', { hash: 'h', size: 4, mode: 0o644, linkTo: undefined });
      this.status = 'Exported';
    }
    if ('Fake' === request.target.node.name) {
      this.status = 'Exported';
    }
    return Promise.resolve({
      delivered: true,
      reachable: true,
      settled: true,
      before,
      after: this.#now(),
    });
  }
}

interface Verdict {
  effect: { ok: boolean };
  verdict: { pass: boolean; failureReason?: string };
  verified?: string;
}

describe('a computer-use peer on the bridge', () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let peer: Peer;
  const app = new FakeApp();

  beforeAll(async () => {
    bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    deps = makeDeps(bridge);
    peer = connectPeer({
      url: `ws://${LOOPBACK_HOST}:${String(port)}${RETICLE_WS_PATH}`,
      sessionId: 'cu-notes',
      projectId: 'notes-app',
      driver: app,
      workspace: {
        roots: ['/out'],
        excluded: [],
        snapshot: () => ({ files: new Map(app.files), unreadable: [] }),
      },
      now: () => Date.now(),
    });
    await peer.ready;
    await waitUntil(() => 1 === bridge.sessions.count());
  });

  afterAll(async () => {
    peer.close();
    await bridge.close();
  });

  it('is a session with no version skew, and says what kind of application it is', async () => {
    await waitUntil(() => undefined !== bridge.sessions.get('cu-notes')?.runtime);
    const listed = (await callTool(deps, 'reticle_sessions', {})) as {
      sessions: { sessionId: string; versionSkew?: string; runtime?: string }[];
    };
    const mine = listed.sessions.find((s) => 'cu-notes' === s.sessionId);
    expect(mine).toBeDefined();
    expect(mine?.versionSkew).toBeUndefined();
    expect(mine?.runtime).toBe('x-computer-use');
  });

  it('gives the application as a tree the tools can act on', async () => {
    const page = (await callTool(deps, 'reticle_snapshot', {})) as { tree: string };
    expect(page.tree).toContain('- button "Save" (ref=e2)');
  });

  it('proves an action by what the application showed after it', async () => {
    const result = (await callTool(deps, 'reticle_act_and_wait', {
      ref: 'e2',
      action: 'click',
      timeout_ms: 2000,
      until: { kind: 'element', query: { text: 'Saved' }, state: ElementState.VISIBLE },
    })) as Verdict;
    expect(app.pressed).toEqual(['Save']);
    expect(result.effect.ok).toBe(true);
    expect(result.verdict.pass, result.verdict.failureReason).toBe(true);
  });

  it('does not pass an action that changed nothing', async () => {
    app.status = 'Ready';
    const result = (await callTool(deps, 'reticle_act_and_wait', {
      ref: 'e3',
      action: 'click',
      timeout_ms: 600,
      until: { kind: 'element', query: { text: 'Saved' }, state: ElementState.VISIBLE },
    })) as Verdict;
    expect(app.pressed).toEqual(['Save', 'Dead']);
    expect(result.verdict.pass).toBe(false);
    // A red verdict on a web page says: add a build plugin, fire a signal. There is no SDK in a
    // desktop application, so that advice is not given.
    const gaps = (result as { instrumentationGaps?: { kind: string }[] }).instrumentationGaps ?? [];
    expect(
      gaps.map((gap) => gap.kind).filter((kind) => /source-mapping|signal|store/.test(kind)),
    ).toEqual([]);
  });

  it('tells a file that was written from words that say so', async () => {
    const page = (await callTool(deps, 'reticle_snapshot', {})) as { tree: string };
    const refOf = (name: string): string =>
      new RegExp(`button "${name}" \\(ref=(e\\d+)\\)`).exec(page.tree)?.[1] ?? '';
    const fileWritten = {
      kind: 'signal',
      name: 'file.written',
      dataMatches: { file: 'note.txt' },
    };
    const fake = (await callTool(deps, 'reticle_act_and_wait', {
      ref: refOf('Fake'),
      action: 'click',
      timeout_ms: 600,
      until: fileWritten,
    })) as Verdict;
    expect(app.status).toBe('Exported');
    expect(fake.verdict.pass).toBe(false);

    const real = (await callTool(deps, 'reticle_act_and_wait', {
      ref: refOf('Export'),
      action: 'click',
      timeout_ms: 2000,
      until: fileWritten,
    })) as Verdict;
    expect(real.verdict.pass, real.verdict.failureReason).toBe(true);
  });

  it('does not prove a text that a window of another application covers', async () => {
    const page = (await callTool(deps, 'reticle_snapshot', {})) as { tree: string };
    const save = /button "Save" \(ref=(e\d+)\)/.exec(page.tree)?.[1] ?? '';
    app.status = 'Ready';
    app.covered = true;
    const result = (await callTool(deps, 'reticle_act_and_wait', {
      ref: save,
      action: 'click',
      timeout_ms: 600,
      until: { kind: 'element', query: { text: 'Saved' }, state: ElementState.VISIBLE },
    })) as Verdict;
    app.covered = false;
    // The text is in the tree. Nobody could see it.
    expect(app.status).toBe('Saved');
    expect(result.verdict.pass).toBe(false);
  });
});
