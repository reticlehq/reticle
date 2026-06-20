import { describe, expect, it } from 'vitest';
import { LIVE_CONTROL_TOOLS } from './live-control-tools.js';
import { IrisTool } from '../tools/tool-names.js';
import type { SessionManager } from './session.js';
import type { ToolDeps } from '../tools/tools.js';

function waitReadyTool() {
  const t = LIVE_CONTROL_TOOLS.find((x) => x.name === IrisTool.WAIT_READY);
  if (t === undefined) throw new Error('no iris_wait_ready tool');
  return t;
}

function depsWithCount(count: number): ToolDeps {
  const sessions: Partial<SessionManager> = { count: () => count };
  return { sessions: sessions as SessionManager, now: () => 0 } as unknown as ToolDeps;
}

interface ReadyShape {
  ready: boolean;
  sessionCount: number;
  recovery?: string;
}

describe('iris_wait_ready tool', () => {
  it('returns ready immediately when a session is already connected', async () => {
    const res = (await waitReadyTool().handler(depsWithCount(1), {})) as ReadyShape;
    expect(res.ready).toBe(true);
    expect(res.sessionCount).toBe(1);
    expect('recovery' in res).toBe(false);
  });

  it('returns not-ready with a recovery hint when no session appears before the timeout', async () => {
    const res = (await waitReadyTool().handler(depsWithCount(0), { timeoutMs: 0 })) as ReadyShape;
    expect(res.ready).toBe(false);
    expect(res.sessionCount).toBe(0);
    expect(res.recovery).toMatch(/iris status/);
  });
});
