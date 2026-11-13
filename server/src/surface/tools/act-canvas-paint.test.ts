import { describe, expect, it } from 'vitest';
import {
  BlindSpotKind,
  CanvasTrigger,
  ContradictionKind,
  EventType,
  ReticleTool,
  SessionState,
} from '@reticlehq/core';
import type { CommandResult, ReticleEvent } from '@reticlehq/core';
import { LastAct } from '@/portal/session/last-act.js';
import { TOOLS, type ToolDeps } from './tools.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import type { HonestyBlock } from '@reticlehq/engine/evidence/honesty.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

/**
 * A canvas app on the act path (#1525). The store commits, no DOM node moves, and the canvas is the
 * render. A canvas that showed a change is the screen moving, so `state-vs-render` must not fire. A
 * canvas that showed no change the digest could see leaves the rule silent too, and the coverage
 * line must SAY why, so the gap is stated and not hidden.
 *
 * This pins the WIRING: the canvas digest from before the act reaches the rule through `prior`, and
 * the canvas spot reaches the coverage line. Engine unit tests stay green if either is dropped here.
 */
const ACT_AT = 1000;
const digest = (t: number, value: string, trigger: CanvasTrigger): ReticleEvent => ({
  t,
  seq: t,
  type: EventType.CANVAS_DIGEST,
  sessionId: 'demo',
  ref: 'e7',
  data: { digest: value, width: 300, height: 150, mean: [200, 200, 200], trigger },
});
const stateChange: ReticleEvent = {
  t: ACT_AT + 5,
  seq: ACT_AT + 5,
  type: EventType.STATE_CHANGE,
  sessionId: 'demo',
  data: { store: 'board', path: 'count', value: 1, prev: 0 },
};

function fakeSession(windowEvents: ReticleEvent[]): Session {
  const before = [digest(ACT_AT - 400, 'aaaa0001', CanvasTrigger.POLL)];
  const command = (): Promise<CommandResult> =>
    Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: { dispatched: true, settled: true, effect: { domMutatedWithin: 0, canvases: 1 } },
    });
  const stub: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost:5173/app',
    elapsed: () => ACT_AT,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    command,
    queryEvents: () => Promise.resolve([...before, ...windowEvents]),
    eventsSince: () => windowEvents,
    bufferHealth: () => ({ total: 10, dropped: 0 }),
    lostSince: () => false,
    blindSpots: () => ({}),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
    onEvent: () => () => undefined,
    ambientCounts: () => ({}),
  };
  return stub as Session;
}

function fakeDeps(session: Session): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => session };
  const root = '/tmp/reticle-test/.reticle';
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

async function act(windowEvents: ReticleEvent[]) {
  const found = TOOLS.find((t) => t.name === ReticleTool.ACT_AND_WAIT);
  if (found === undefined) {
    throw new Error('no act_and_wait tool');
  }
  const deps = fakeDeps(fakeSession(windowEvents));
  return (await found.handler(deps, {
    ref: 'e1',
    action: 'click',
    until: { kind: 'settled' },
  })) as { honesty?: HonestyBlock; contradictions?: { kind: string }[] };
}

const kinds = (r: { contradictions?: { kind: string }[] }): string[] =>
  (r.contradictions ?? []).map((c) => c.kind);

describe('act_and_wait on a canvas-rendered app', () => {
  it('reads a changed canvas as the render: no state-vs-render, and full coverage', async () => {
    const r = await act([stateChange, digest(ACT_AT + 10, 'bbbb0002', CanvasTrigger.ACT)]);
    expect(kinds(r)).not.toContain(ContradictionKind.STATE_VS_RENDER);
    expect(r.honesty?.coverage.partial).toBe(false);
  });

  it('names "canvas paint not observed" when the canvas showed no change', async () => {
    const r = await act([stateChange, digest(ACT_AT + 10, 'aaaa0001', CanvasTrigger.ACT)]);
    expect(kinds(r)).not.toContain(ContradictionKind.STATE_VS_RENDER);
    expect(r.honesty?.coverage.partial).toBe(true);
    expect(r.honesty?.coverage.note).toContain('canvas paint not observed');
    expect(r.honesty?.integrity.clean).toBe(true);
  });

  it('still raises state-vs-render, with no canvas note, when no canvas is in the window', async () => {
    const r = await act([stateChange]);
    expect(kinds(r)).toContain(ContradictionKind.STATE_VS_RENDER);
    expect(r.honesty?.coverage.note ?? '').not.toContain('canvas');
  });

  it('keeps the kind in core, so a host can read the gap by name', () => {
    expect(BlindSpotKind.CANVAS_PAINT_UNOBSERVED).toBe('canvas-paint-unobserved');
  });
});
