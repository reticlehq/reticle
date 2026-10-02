/**
 * `burst` shipped with no test that could go red.
 *
 * The incident is this release's own: `burst` — a deliberate gap between step dispatches, so a race
 * can be provoked rather than hoped for — landed with its only coverage being an advertised-surface
 * byte budget raised 24_500 -> 24_600. That measures the schema STRING. Deleting the `settleMs: 0`
 * injection, or the clamp, left the whole suite green.
 *
 * What is asserted here is the injection and the clamp, both of which are facts about the ARGUMENTS
 * the handler sends. The pacing itself is a duration, and this repository's rule is that a timing
 * assertion is a bug: `Date.now() - t < N` is a statement about the machine and fails only under
 * parallel load. So the gap is deliberately NOT asserted by wall clock here. The property that
 * makes the overlap possible at all IS assertable without a clock: in burst mode every dispatch
 * carries a zero settle budget, so step N+1 goes out while step N is still in flight. Without it
 * the default settle would pace the sequence and there would be no race to provoke, which is
 * exactly the earlier attempt the handler's own comment records as producing "a 12ms step and no
 * race at all".
 */

import { describe, expect, it } from 'vitest';
import { LastAct } from '@/portal/session/last-act.js';
import { SessionState } from '@reticlehq/core';
import type { CommandResult, ReticleEvent } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';
import { ReticleTool } from '@reticlehq/core';
import { BaselineStore } from '@/memory/project/baselines.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

/** Every `act` command the handler sent, in order, so the dispatched args can be read back. */
function fakeSession(sent: Record<string, unknown>[]): Session {
  let stepIndex = 0;
  const command = (name: string, args: Record<string, unknown> = {}): Promise<CommandResult> => {
    if ('act' === name) {
      sent.push(args);
      const i = stepIndex++;
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: {
          ref: `e${String(i + 1)}`,
          action: 'click',
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
    // Held constant so the handler's own gap arithmetic (`elapsed() - stepSince`) resolves to a
    // zero-length wait. This test is about the arguments, not about how long anything took.
    elapsed: () => 0,
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
    onEvent: () => () => undefined,
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

const STEPS = [
  { ref: 'e1', action: 'click' },
  { ref: 'e2', action: 'click' },
];

/** The `args` bag of each dispatched act, which is where a step's settle budget rides. */
async function dispatchedArgs(extra: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const sent: Record<string, unknown>[] = [];
  const session = fakeSession(sent);
  await tool(ReticleTool.ACT_SEQUENCE).handler(fakeDeps(session), { steps: STEPS, ...extra });
  return sent.map((c) => (c['args'] ?? {}) as Record<string, unknown>);
}

describe('act_sequence burst', () => {
  it('sends a zero settle budget on every step, so the next dispatch overlaps this one', async () => {
    const sent = await dispatchedArgs({ burst: 30 });

    expect(sent).toHaveLength(2);
    for (const args of sent) {
      expect(args['settleMs'], 'a burst step must not wait for its own settle').toBe(0);
    }
  });

  it('leaves the settle budget alone when burst was not asked for', async () => {
    // The negative control. Injecting `settleMs: 0` unconditionally would silently turn every
    // sequence into a burst, which is the same defect pointed the other way.
    const sent = await dispatchedArgs({});

    expect(sent).toHaveLength(2);
    for (const args of sent) {
      expect(args['settleMs']).toBeUndefined();
    }
  });

  it('clamps a gap above the ceiling rather than honouring it', async () => {
    // The clamp is belt-and-braces against the advertised schema, and it is the replay path — which
    // reaches this handler with no schema in front of it — that actually needs it. A burst is still
    // a burst: the steps go out, and they go out with no settle.
    // Deliberately a plain literal far above any ceiling, rather than importing the constant:
    // the clamp's job is to survive a value nobody sanity-checked, and a test that computes its
    // input from the same constant cannot tell a clamp from an accident.
    const sent = await dispatchedArgs({ burst: 50_000 });

    expect(sent).toHaveLength(2);
    for (const args of sent) expect(args['settleMs']).toBe(0);
  });

  it('treats a non-numeric burst as absent rather than as zero', async () => {
    // `burst: 0` is legal and means "no gap at all"; `burst: "fast"` is a malformed call. Reading
    // the second as the first would turn a typo into a silent behaviour change.
    const sent = await dispatchedArgs({ burst: 'fast' });

    expect(sent).toHaveLength(2);
    for (const args of sent) expect(args['settleMs']).toBeUndefined();
  });
});
