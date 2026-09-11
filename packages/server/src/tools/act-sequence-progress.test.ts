import { describe, expect, it } from 'vitest';
import { LastAct } from '../session/last-act.js';
import { SessionState } from '@reticlehq/core';
import type { CommandResult, ReticleEvent } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import type { Session, SessionManager } from '../session/session.js';

interface Options {
  /** When set, the step at this index will fail. */
  failAtStep?: number;
  /** When set, the step at this index will time out (reject). */
  timeoutAtStep?: number;
}

function fakeSession(options: Options): Session {
  let stepIndex = 0;
  const command = (name: string): Promise<CommandResult> => {
    if ('act' === name) {
      const i = stepIndex++;
      if (i === options.failAtStep) {
        return Promise.resolve({
          kind: 'command_result',
          id: 'c',
          ok: false,
          error: `step ${String(i)} failed: ref not found`,
        });
      }
      if (i === options.timeoutAtStep) {
        return Promise.reject(new Error('command timed out after 8000ms'));
      }
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: {
          ref: `e${String(i + 1)}`,
          action: 'fill',
          dispatched: true,
          settled: true,
          settleReason: null,
          effect: { domMutatedWithin: 1 },
        },
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  };
  const noEvents: ReticleEvent[] = [];
  const stub: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost:5173/app',
    elapsed: () => 1000,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    command,
    queryEvents: () => Promise.resolve(noEvents),
    eventsSince: () => noEvents,
    bufferHealth: () => ({ total: 0, dropped: 0 }),
    lostSince: () => false,
    blindSpots: () => ({}),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
  };
  return stub as Session;
}

function fakeDeps(session: Session): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), '/tmp/reticle-test/.reticle', {
      now: () => 0,
    }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: '/tmp/reticle-test/.reticle',
    now: () => 0,
  };
}

function tool(name: string) {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no ${name} tool`);
  return found;
}

interface SequenceResult {
  since: number;
  dispatched: boolean;
  completed: number;
  stalled_at?: number;
  steps?: {
    ref?: string;
    action?: string;
    dispatched?: boolean | null;
    timedOut?: boolean;
    error?: string;
  }[];
}

describe('act_sequence per-step progress', () => {
  it('reports all steps completed on success', async () => {
    const session = fakeSession({});
    const deps = fakeDeps(session);

    const result = (await tool(ReticleTool.ACT_SEQUENCE).handler(deps, {
      steps: [
        { ref: 'e1', action: 'fill', args: { value: 'a@b.com' } },
        { ref: 'e2', action: 'fill', args: { value: 'hunter2' } },
        { ref: 'e3', action: 'click' },
      ],
    })) as SequenceResult;

    expect(result.completed).toBe(3);
    expect(result.stalled_at).toBeUndefined();
    expect(result.dispatched).toBe(true);
    expect(result.steps).toHaveLength(3);
  });

  it('reports partial progress when a middle step fails', async () => {
    const session = fakeSession({ failAtStep: 1 });
    const deps = fakeDeps(session);

    const result = (await tool(ReticleTool.ACT_SEQUENCE).handler(deps, {
      steps: [
        { ref: 'e1', action: 'fill', args: { value: 'a@b.com' } },
        { ref: 'e2', action: 'fill', args: { value: 'hunter2' } },
        { ref: 'e3', action: 'click' },
      ],
    })) as SequenceResult;

    expect(result.completed).toBe(1);
    expect(result.stalled_at).toBe(1);
    expect(result.dispatched).toBe(true);
    expect(result.steps).toHaveLength(2);
    const stalled = result.steps?.[1];
    expect(stalled?.dispatched).toBe(false);
    expect(stalled?.error).toContain('step 1 failed');
  });

  it('reports partial progress when a step times out', async () => {
    const session = fakeSession({ timeoutAtStep: 2 });
    const deps = fakeDeps(session);

    const result = (await tool(ReticleTool.ACT_SEQUENCE).handler(deps, {
      steps: [
        { ref: 'e1', action: 'fill', args: { value: 'a@b.com' } },
        { ref: 'e2', action: 'fill', args: { value: 'hunter2' } },
        { ref: 'e3', action: 'click' },
      ],
    })) as SequenceResult;

    expect(result.completed).toBe(2);
    expect(result.stalled_at).toBe(2);
    expect(result.steps).toHaveLength(3);
    const stalled = result.steps?.[2];
    expect(stalled?.dispatched).toBeNull();
    expect(stalled?.timedOut).toBe(true);
    expect(stalled?.error).toContain('timed out');
  });

  it('marks the act cursor only when at least one step completed', async () => {
    const session = fakeSession({ failAtStep: 0 });
    const deps = fakeDeps(session);

    await tool(ReticleTool.ACT_SEQUENCE).handler(deps, {
      steps: [{ ref: 'e1', action: 'click' }],
    });

    expect(session.lastAct.cursor()).toBeUndefined();
  });

  it('marks the act cursor when steps did complete', async () => {
    const session = fakeSession({ failAtStep: 2 });
    const deps = fakeDeps(session);

    await tool(ReticleTool.ACT_SEQUENCE).handler(deps, {
      steps: [
        { ref: 'e1', action: 'fill', args: { value: 'a' } },
        { ref: 'e2', action: 'fill', args: { value: 'b' } },
        { ref: 'e3', action: 'click' },
      ],
    });

    expect(session.lastAct.cursor()).toBe(1000);
  });

  it('returns dispatched:false when zero steps completed', async () => {
    const session = fakeSession({ failAtStep: 0 });
    const deps = fakeDeps(session);

    const result = (await tool(ReticleTool.ACT_SEQUENCE).handler(deps, {
      steps: [{ ref: 'e1', action: 'click' }],
    })) as SequenceResult;

    expect(result.dispatched).toBe(false);
    expect(result.completed).toBe(0);
  });

  it('distinguishes "refused" (retry safe) from "timed out" (retry unsafe)', async () => {
    const refused = fakeSession({ failAtStep: 0 });
    const timedOut = fakeSession({ timeoutAtStep: 0 });
    const refusedDeps = fakeDeps(refused);
    const timedOutDeps = fakeDeps(timedOut);

    const refusedResult = (await tool(ReticleTool.ACT_SEQUENCE).handler(refusedDeps, {
      steps: [{ ref: 'e1', action: 'click' }],
    })) as SequenceResult;

    const timedOutResult = (await tool(ReticleTool.ACT_SEQUENCE).handler(timedOutDeps, {
      steps: [{ ref: 'e1', action: 'click' }],
    })) as SequenceResult;

    const refusedStep = refusedResult.steps?.[0];
    const timedOutStep = timedOutResult.steps?.[0];

    expect(refusedStep?.dispatched).toBe(false);
    expect(refusedStep?.timedOut).toBeUndefined();

    expect(timedOutStep?.dispatched).toBeNull();
    expect(timedOutStep?.timedOut).toBe(true);
  });
});
