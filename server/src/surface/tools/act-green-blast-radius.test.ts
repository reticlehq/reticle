import { describe, expect, it } from 'vitest';
import {
  EventType,
  ReticleTool,
  SessionState,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { LastAct } from '../../portal/session/last-act.js';
import { TOOLS, type ToolDeps } from './tools.js';
import { BaselineStore } from '../../features/project/baselines.js';
import { createNodeFileSystem } from '../../features/project/fs/fs-port.js';
import { RecordingStore } from '../../features/flows/recording/tape/recordings.js';
import type { Session, SessionManager } from '../../portal/session/session.js';

/**
 * A verdict that PASSED is the only place the blast radius is news.
 *
 * On a red the divergence capsule already carries it and the fault is the headline. On a green
 * nothing carried it at all — the capsule is built red-only, deliberately, to keep the common path
 * cheap. So "the consequence I declared held, AND this action also posted somewhere I never
 * mentioned" was computed by nobody and reported to nobody.
 *
 * That is the finding a passing verdict buries, and the one the idea exists for: a click that works
 * and also fires a DELETE is a green that did extra damage.
 */

let seq = 0;
function event(type: EventType, data: Record<string, unknown>): ReticleEvent {
  seq += 1;
  return { t: seq, seq, type, sessionId: 'demo', data };
}

function sessionWith(events: ReticleEvent[]): Session {
  const stub: Partial<Session> = {
    id: 'demo',
    url: 'http://localhost/',
    elapsed: () => 1000,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    command: () =>
      Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: { dispatched: true, settled: true, effect: { domMutatedWithin: 1 } },
      } as CommandResult),
    queryEvents: () => Promise.resolve(events),
    eventsSince: () => events,
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

function deps(session: Session): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    fs: createNodeFileSystem(),
    reticleRoot: '/tmp/reticle-test/.reticle',
    now: () => 0,
  } as unknown as ToolDeps;
}

function tool(name: string) {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
}

const SIGNAL = 'order:placed';

async function act(events: ReticleEvent[]): Promise<{ verified?: string; blastRadius?: string[] }> {
  const session = sessionWith(events);
  return (await tool(ReticleTool.ACT_AND_WAIT).handler(deps(session), {
    ref: 'e1',
    action: 'click',
    until: { kind: 'signal', name: SIGNAL },
    timeout_ms: 0,
  })) as { verified?: string; blastRadius?: string[] };
}

describe('what a passing action also did', () => {
  it('reports a request the action never declared', async () => {
    const result = await act([
      event(EventType.SIGNAL, { name: SIGNAL }),
      event(EventType.NET_REQUEST, { method: 'DELETE', url: '/api/cart', status: 200 }),
    ]);
    // Vacuity: on anything but a pass the capsule would be carrying this instead.
    expect(result.verified).toBe('yes');
    expect(result.blastRadius).toEqual(['net DELETE /api/cart']);
  });

  it('stays silent when nothing outside the declaration moved', async () => {
    // A field that is always present teaches a reader to skim it; the presence IS the signal.
    const result = await act([event(EventType.SIGNAL, { name: SIGNAL })]);
    expect(result.verified).toBe('yes');
    expect(result.blastRadius).toBeUndefined();
  });
});
