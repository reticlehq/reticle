import { describe, expect, it } from 'vitest';
import { SessionState, type ReticleEvent } from '@reticlehq/core';
import { LastAct } from '../session/last-act.js';
import { TOOLS, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import type { Session, SessionManager } from '../session/session.js';

/**
 * `reticle_observe` must only judge an act that happened INSIDE the window it is observing.
 *
 * The guard is `actCursor !== undefined && actCursor >= since`. Found by mutation: dropping the
 * `actCursor >= since` half failed ZERO tests, while dropping the whole guard fails one. So the
 * half that decides WHICH window the act belongs to was completely undefended.
 *
 * Without it, an act from an earlier window has its effect fed to the contradiction engine on a
 * later, unrelated observe — which produces `action-had-no-effect`: "the click was dispatched and
 * the page settled … the target does not react to this action". A confident accusation about a
 * control that is fine, derived from an action the window does not contain.
 *
 * That is not hypothetical. `refused-act-leaves-nothing.test.ts` exists because the same
 * contradiction was reported from the field for the adjacent reason (act state surviving a REFUSED
 * act). This is the other way to reach it: act state surviving into a later WINDOW.
 */
function fakeSession(lastAct: LastAct): Session {
  const noEvents: ReticleEvent[] = [];
  const stub: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost:5173/app',
    elapsed: () => 1000,
    lastAct,
    queryEvents: () => Promise.resolve(noEvents),
    eventsSince: () => noEvents,
    bufferHealth: () => ({ total: 0, dropped: 0 }),
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

/** An act that dispatched, settled, and moved nothing — the shape that earns the accusation. */
function actAt(cursor: number): LastAct {
  const a = new LastAct();
  a.markActed(cursor, 'click', 0);
  return a;
}

async function observe(deps: ToolDeps, since: number): Promise<{ contradictions?: unknown[] }> {
  return (await TOOLS.find((t) => t.name === ReticleTool.OBSERVE)?.handler(deps, {
    since,
  })) as { contradictions?: unknown[] };
}

describe('observe judges only an act inside the window', () => {
  it('does not blame a control for an act that happened BEFORE this window', async () => {
    // Act at cursor 5; the caller is asking about everything since 100. The act is not in here.
    const r = await observe(fakeDeps(fakeSession(actAt(5))), 100);
    expect(
      r.contradictions ?? [],
      'an act outside the window must not be judged by it',
    ).toHaveLength(0);
  });

  it('DOES judge an act inside the window — the guard must not silence the real case', async () => {
    // The control. A guard that never judged anything would pass the test above and destroy the
    // feature, which is the more expensive direction to get wrong.
    const r = await observe(fakeDeps(fakeSession(actAt(150))), 100);
    expect(r.contradictions ?? []).not.toHaveLength(0);
  });

  it('judges an act exactly ON the boundary — `>= since`, not `>`', async () => {
    // An act at the cursor the caller passed IS in the window; observe is called with the cursor the
    // act returned, so off-by-one here silences the single commonest sequence there is.
    const r = await observe(fakeDeps(fakeSession(actAt(100))), 100);
    expect(r.contradictions ?? []).not.toHaveLength(0);
  });
});
