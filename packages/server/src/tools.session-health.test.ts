import { describe, expect, it } from 'vitest';
import { UNSCRIPTABLE_TAB_RECOMMENDATION } from '@iris/protocol';
import type { CommandResult } from '@iris/protocol';
import { TOOLS, type ToolDeps } from './tools.js';
import { IrisTool } from './tool-names.js';
import { BaselineStore } from './baselines.js';
import { createNodeFileSystem } from './fs-port.js';
import { RecordingStore } from './recordings.js';
import { FlowStore } from './flows.js';
import { AnnotationStore } from './annotation-store.js';
import type { Session, SessionInfo, SessionManager } from './session.js';

const SESSION_URL = 'http://localhost:5173/app';

/** A minimal fake Session whose health()/throttled() are configurable per test. */
function fakeSession(throttled: boolean): Session {
  const command = (): Promise<CommandResult> =>
    Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: { dispatched: true, settled: true },
    });
  const health = throttled
    ? {
        lastSeenMs: 0,
        throttled: true,
        focused: false,
        recommendation: UNSCRIPTABLE_TAB_RECOMMENDATION,
      }
    : { lastSeenMs: 0, throttled: false, focused: true };
  const stub: Partial<Session> = {
    id: 'demo',
    url: SESSION_URL,
    elapsed: () => 0,
    eventsSince: () => [],
    command,
    health: () => health,
    throttled: () => throttled,
  };
  return stub as Session;
}

function fakeDeps(throttled: boolean, listRows: SessionInfo[]): ToolDeps {
  const session = fakeSession(throttled);
  const sessions: Partial<SessionManager> = {
    resolve: () => session,
    list: () => listRows,
  };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), '/tmp/iris-test/.iris', { now: () => 0 }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    irisRoot: '/tmp/iris-test/.iris',
    now: () => 0,
  };
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

interface HealthBlock {
  session: { recommendation?: string };
}

const healthyRow: SessionInfo = {
  sessionId: 'h',
  url: SESSION_URL,
  title: 'Healthy',
  adapters: [],
  hasCapabilities: false,
  lastSeenMs: 0,
  hidden: false,
  focused: true,
  throttled: false,
};

const throttledRow: SessionInfo = {
  sessionId: 't',
  url: SESSION_URL,
  title: 'Throttled',
  adapters: [],
  hasCapabilities: false,
  lastSeenMs: 99_999,
  hidden: true,
  focused: false,
  throttled: true,
  recommendation: UNSCRIPTABLE_TAB_RECOMMENDATION,
};

describe('P2-surface tool results carry the recommendation', () => {
  it('act result surfaces the recommendation for a throttled tab', async () => {
    const res = (await tool(IrisTool.ACT).handler(fakeDeps(true, []), {
      ref: 'e1',
      action: 'click',
    })) as HealthBlock;
    expect(res.session.recommendation).toBe(UNSCRIPTABLE_TAB_RECOMMENDATION);
    expect(res.session.recommendation).toContain('iris drive');
  });

  it('act result has no recommendation for a healthy tab', async () => {
    const res = (await tool(IrisTool.ACT).handler(fakeDeps(false, []), {
      ref: 'e1',
      action: 'click',
    })) as HealthBlock;
    expect('recommendation' in res.session).toBe(false);
  });

  it('assert result surfaces the recommendation', async () => {
    const res = (await tool(IrisTool.ASSERT).handler(fakeDeps(true, []), {
      predicate: { kind: 'console', level: 'error', absent: true },
    })) as HealthBlock;
    expect(res.session.recommendation).toBe(UNSCRIPTABLE_TAB_RECOMMENDATION);
  });

  it('sessions list carries per-row recommendation for an un-scriptable tab', async () => {
    const res = (await tool(IrisTool.SESSIONS).handler(fakeDeps(false, [throttledRow]), {})) as {
      sessions: SessionInfo[];
    };
    expect(res.sessions[0]?.recommendation).toBe(UNSCRIPTABLE_TAB_RECOMMENDATION);
  });

  it('sessions list omits recommendation for healthy rows', async () => {
    const res = (await tool(IrisTool.SESSIONS).handler(fakeDeps(false, [healthyRow]), {})) as {
      sessions: SessionInfo[];
    };
    const row = res.sessions[0];
    expect(row !== undefined && 'recommendation' in row).toBe(false);
  });
});
