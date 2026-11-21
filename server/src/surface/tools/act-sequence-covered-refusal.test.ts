/**
 * A sequence step refused for a cover is not a failed consequence.
 *
 * CI e2e: in `act { steps }`, a click on a button under a full-screen overlay was refused before it
 * was sent, and the plan was graded `verified: no` (`assertion_failed`). Nothing reached the app, so
 * nothing about the app failed: a "no" there is a false red. The step is undecided, like a target
 * that matched no element, and the refusal stays in its `error`.
 */
import { describe, expect, it } from 'vitest';
import { LastAct } from '@/portal/session/last-act.js';
import { ReticleTool, SessionState, Verified } from '@reticlehq/core';
import type { CommandResult, ReticleEvent } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

const REFUSAL =
  'click refused: div covers the target, so a person could not click it. Close or dismiss div first, then act again.';

function refusingSession(): Session {
  const noEvents: ReticleEvent[] = [];
  const command = (name: string): Promise<CommandResult> =>
    'act' === name
      ? Promise.resolve({ kind: 'command_result', id: 'c', ok: false, error: REFUSAL })
      : Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
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

function deps(session: Session): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => session, list: () => [] };
  const root = '/tmp/reticle-covered-seq/.reticle';
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), root, { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), root, { now: () => 0 }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: root,
    now: () => 0,
  };
}

describe('a sequence step whose click was refused for a cover', () => {
  it('is undecided, not a failed consequence', async () => {
    const seq = TOOLS.find((t) => t.name === ReticleTool.ACT_SEQUENCE);
    if (seq === undefined) {
      throw new Error('no sequence tool');
    }
    const result = (await seq.handler(deps(refusingSession()), {
      steps: [
        {
          ref: 'e5',
          action: 'click',
          expect: { kind: 'net', method: 'POST', urlContains: '/toggle' },
        },
      ],
    })) as { verified?: string; steps?: { error?: string }[] };
    expect(result.verified, 'a refused click graded the app as broken').not.toBe(Verified.NO);
    expect(result.steps?.[0]?.error ?? '').toMatch(/covers the target/);
  });
});
