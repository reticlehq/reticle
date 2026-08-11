import { describe, expect, it } from 'vitest';
import { SessionState, Verified, VerifiedReason } from '@reticlehq/core';
import type { CommandResult, ReticleEvent } from '@reticlehq/core';
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
 * A verdict whose window LOST events must not grade `proved`.
 *
 * `act_and_wait` marks its window truncated with
 * `truncated: session.bufferHealth().dropped > droppedBefore` — the delta across this one action.
 * That feeds `integrity.issues`, and `!integrity.clean` is what makes `decideVerified` answer
 * UNCLEAN_CAPTURE: "a green here would only describe what was observed".
 *
 * Found by mutation: hardcoding that flag to `false` failed ZERO tests. So a verdict reached over a
 * window the server buffer had evicted during would have come back `proved`, with no trace that
 * part of the window was never seen.
 *
 * Distinct from the Session-level gap (`Session.bufferHealth` delegating to the ring buffer, covered
 * separately): this is act_and_wait's USE of it — the per-action delta — and it had its own hole.
 *
 * Fourth instance of one pattern: a well-tested producer, consumers that stub it, and nothing on the
 * delegation between them.
 */
function fakeSession(drops: number[]): Session {
  const command = (): Promise<CommandResult> =>
    Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: { dispatched: true, settled: true, effect: { domMutatedWithin: 1 } },
    });
  // Successive reads walk the list, so the SECOND read (after the act) can exceed the first —
  // which is exactly the "the buffer evicted while this action ran" condition.
  let read = 0;
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
    bufferHealth: () => ({ total: 10, dropped: drops[Math.min(read++, drops.length - 1)] ?? 0 }),
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

function tool(name: string) {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no ${name} tool`);
  return found;
}

const ACT = { ref: 'e1', action: 'click', until: { kind: 'settled' } };

interface Verdict {
  verified?: string;
  verifiedReason?: string;
  because?: string;
}

describe('act_and_wait declares a window that lost events', () => {
  it('does not grade proved when the buffer evicted DURING the action', async () => {
    // 0 dropped before the act, 12 after: the window this verdict covers has a hole in it.
    const deps = fakeDeps(fakeSession([0, 12]));
    const r = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, ACT)) as Verdict;
    expect(r.verified).toBe(Verified.UNKNOWN);
    expect(r.verifiedReason).toBe(VerifiedReason.UNCLEAN_CAPTURE);
  });

  it('still grades proved when nothing was evicted — the ordinary window is untouched', async () => {
    // The control. A flag stuck ON would caveat every verdict, which is the opposite failure and
    // just as damaging: a warning that is always present is one nobody reads.
    const deps = fakeDeps(fakeSession([3, 3]));
    const r = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, ACT)) as Verdict;
    expect(r.verifiedReason).toBe(VerifiedReason.PROVED);
  });

  it('reads the DELTA, not the total — a buffer that evicted BEFORE this act is not its problem', async () => {
    // 9 already dropped before the action and none during it. Marking that window unclean would
    // blame this verdict for a gap that predates it, and every later act in a long session would
    // inherit a caveat it did not earn.
    const deps = fakeDeps(fakeSession([9, 9]));
    const r = (await tool(ReticleTool.ACT_AND_WAIT).handler(deps, ACT)) as Verdict;
    expect(r.verifiedReason).toBe(VerifiedReason.PROVED);
  });
});
