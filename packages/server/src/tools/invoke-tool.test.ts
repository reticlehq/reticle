import { describe, expect, it } from 'vitest';
import { SessionState, UNSCRIPTABLE_TAB_RECOMMENDATION } from '@syrin/iris-protocol';
import { TOOLS, type ToolDef, type ToolDeps } from './tools.js';
import { IrisTool } from './tool-names.js';
import { runTool, SESSION_BOUND_TOOLS, SESSION_EXEMPT_TOOLS } from './invoke-tool.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import type { Session, SessionManager } from '../session/session.js';

const ROOT = '/tmp/iris-invoke-test/.iris';
const now = (): number => 0;

/** A throttled fake session (complete enough to drive real read-only handlers) whose health()
 *  carries the un-scriptable recommendation. */
function throttledSession(): Session {
  const stub: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost:5173/app',
    command: () => Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} }),
    eventsSince: () => [],
    health: () => ({
      lastSeenMs: 99_999,
      throttled: true,
      focused: false,
      recommendation: UNSCRIPTABLE_TAB_RECOMMENDATION,
    }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
  };
  return stub as Session;
}

function fakeDeps(): ToolDeps {
  const session = throttledSession();
  const sessions: Partial<SessionManager> = { resolve: () => session };
  const fs = createNodeFileSystem();
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, ROOT, { now }),
    project: new ProjectStore(fs, ROOT, { now }),
    annotations: new AnnotationStore(),
    fs,
    irisRoot: ROOT,
    now,
  };
}

/** A minimal ToolDef wrapping a fixed return value, named so it lands in the bound/exempt set. */
function stubTool(name: string, returns: unknown): ToolDef {
  return { name, description: '', inputSchema: {}, handler: () => Promise.resolve(returns) };
}

describe('runTool — universal session-health invariant', () => {
  it('1: splices health onto a session-bound tool returning a plain object', async () => {
    const r = (await runTool(stubTool(IrisTool.ACT, { ok: true }), fakeDeps(), {})) as {
      session?: { throttled?: boolean; recommendation?: string };
    };
    expect(r.session?.throttled).toBe(true);
    expect(r.session?.recommendation).toBe(UNSCRIPTABLE_TAB_RECOMMENDATION);
  });

  it('2: does NOT add health to an exempt (disk/lifecycle) tool', async () => {
    const r = (await runTool(stubTool(IrisTool.PROJECT, { ok: true }), fakeDeps(), {})) as {
      session?: unknown;
    };
    expect('session' in r).toBe(false);
  });

  it('3: is idempotent — a handler that already added session is left untouched', async () => {
    const existing = { ok: true, session: { throttled: false, lastSeenMs: 1 } };
    const r = (await runTool(stubTool(IrisTool.ACT, existing), fakeDeps(), {})) as {
      session: { throttled: boolean };
    };
    expect(r.session.throttled).toBe(false); // not overwritten
  });

  it('4: never corrupts a non-object result (array / primitive pass through)', async () => {
    const name = IrisTool.ACT;
    expect(await runTool(stubTool(name, [1, 2, 3]), fakeDeps(), {})).toEqual([1, 2, 3]);
    expect(await runTool(stubTool(name, 42), fakeDeps(), {})).toBe(42);
  });

  it('5: STRUCTURAL GUARD — every sessionId-bearing tool is classified bound XOR exempt', () => {
    const overlap = [...SESSION_BOUND_TOOLS].filter((n) => SESSION_EXEMPT_TOOLS.has(n));
    expect(overlap).toEqual([]); // a tool may not be in both sets
    for (const tool of TOOLS) {
      const hasSessionId = Object.keys(tool.inputSchema).includes('sessionId');
      if (!hasSessionId) continue;
      const classified = SESSION_BOUND_TOOLS.has(tool.name) || SESSION_EXEMPT_TOOLS.has(tool.name);
      expect(classified, `${tool.name} carries sessionId but is neither bound nor exempt`).toBe(
        true,
      );
    }
  });

  it('6: every name in the bound/exempt sets is a real tool (no dangling names)', () => {
    const all = new Set(TOOLS.map((t) => t.name));
    for (const n of [...SESSION_BOUND_TOOLS, ...SESSION_EXEMPT_TOOLS])
      expect(all.has(n)).toBe(true);
  });

  it('7: real handlers — previously-bare tools now carry health through runTool', async () => {
    const deps = fakeDeps();
    const tool = (name: string): ToolDef => {
      const t = TOOLS.find((x) => x.name === name);
      if (t === undefined) throw new Error(`no tool ${name}`);
      return t;
    };
    for (const name of ['iris_network', 'iris_console', 'iris_state']) {
      const r = (await runTool(tool(name), deps, {})) as { session?: { throttled?: boolean } };
      expect(r.session?.throttled, `${name} should carry health`).toBe(true);
    }
  });
});
