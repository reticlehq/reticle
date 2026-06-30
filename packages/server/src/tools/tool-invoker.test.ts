import { describe, expect, it } from 'vitest';
import { createToolInvoker, UNKNOWN_TOOL_ERROR } from './tool-invoker.js';
import { ReticleTool } from './tool-names.js';
import type { ToolDeps } from './tools.js';
import type { SessionManager } from '../session/session.js';

/** Minimal ToolDeps stub: only `sessions.list()` is exercised by reticle_sessions. */
function fakeDeps(): ToolDeps {
  const sessions: Partial<SessionManager> = { list: () => [] };
  return { sessions: sessions as SessionManager } as unknown as ToolDeps;
}

describe('createToolInvoker', () => {
  it('invoke dispatches to the named tool handler with deps and args', async () => {
    const invoke = createToolInvoker(fakeDeps());
    const result = await invoke(ReticleTool.SESSIONS, {});
    expect(result).toEqual({ sessions: [] });
  });

  it('an unknown tool name rejects with a named error', async () => {
    const invoke = createToolInvoker(fakeDeps());
    await expect(invoke('reticle_nope', {})).rejects.toThrow(UNKNOWN_TOOL_ERROR);
  });

  it('a tool handler error propagates (not swallowed)', async () => {
    // reticle_diff throws when the baseline does not exist — a handler error path.
    const sessions: Partial<SessionManager> = { resolve: () => ({}) as never };
    const deps = {
      sessions: sessions as SessionManager,
      baselines: { get: (): undefined => undefined },
    } as unknown as ToolDeps;
    const invoke = createToolInvoker(deps);
    await expect(invoke(ReticleTool.DIFF, { baseline: 'missing' })).rejects.toThrow();
  });
});
