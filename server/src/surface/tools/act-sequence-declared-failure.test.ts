/**
 * A journey step that declares a failed request is judged as `reticle_act_and_wait` judges it.
 *
 * The step path ran the contradiction rules without the step's own `expect`. A save that the step
 * said would be refused with a 409 held, and the step still answered `no` with
 * `ui-advanced-request-failed`. The same click in `act_and_wait` answered `yes`.
 */
import { describe, expect, it } from 'vitest';
import {
  EventType,
  ReticleTool,
  SessionState,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { LastAct } from '@/portal/session/last-act.js';
import { TOOLS, type ToolDeps } from './tools.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

const ROOT = '/tmp/reticle-act-sequence-declared-failure/.reticle';
const URL = 'http://localhost:4312/api/save';

/** A page where the save is refused with a 409 and the page shows a refusal message. */
function refusedSaveSession(): Session {
  const start = Date.now();
  const clock = (): number => Date.now() - start;
  const events: ReticleEvent[] = [];
  const listeners = new Set<(event: ReticleEvent) => void>();
  const push = (type: EventType, data: Record<string, unknown>): void => {
    const event = { t: clock(), type, sessionId: 's1', data } as ReticleEvent;
    events.push(event);
    for (const listener of listeners) {
      listener(event);
    }
  };
  const command = (): Promise<CommandResult> => {
    push(EventType.DOM_ADDED, { path: 'p.refusal' });
    push(EventType.NET_REQUEST, {
      id: 'r1',
      method: 'POST',
      url: URL,
      status: 409,
      ok: false,
      initiator: 'fetch',
    });
    return Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: { ref: 'e1', action: 'click', dispatched: true, settled: true, settleReason: null },
    });
  };
  const stub: Partial<Session> = {
    id: 's1',
    url: 'http://localhost:4312/compose',
    elapsed: clock,
    lastAct: new LastAct(),
    beginAction: () => 'a0',
    finishAction: () => undefined,
    recordAction: () => 'a1',
    readJournalActions: () => Promise.resolve([]),
    setState: () => undefined,
    command,
    queryEvents: () => Promise.resolve(events),
    eventsSince: (since: number) => events.filter((e) => e.t >= since),
    bufferHealth: () => ({ total: events.length, dropped: 0 }),
    lostSince: () => false,
    blindSpots: () => ({}),
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    throttled: () => false,
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
    inboxSize: () => 0,
    onEvent: (listener: (event: ReticleEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return stub as Session;
}

function depsFor(session: Session): ToolDeps {
  const sessions: Partial<SessionManager> = {
    resolve: () => session,
    get: () => session,
    count: () => 1,
    departed: () => undefined,
  };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: ROOT,
    now: () => 0,
  };
}

const sequence = TOOLS.find((t) => t.name === ReticleTool.ACT_SEQUENCE);

type Answer = {
  verified: string;
  steps: { held?: boolean; contradictions?: { kind: string }[] }[];
};

describe('a journey step that declared a failed request', () => {
  it('answers yes when the step expects the 409', async () => {
    if (sequence === undefined) {
      throw new Error('no act_sequence tool');
    }
    const result = (await sequence.handler(depsFor(refusedSaveSession()), {
      steps: [{ ref: 'e1', action: 'click', expect: { kind: 'net', method: 'POST', status: 409 } }],
      timeout_ms: 2000,
    })) as Answer;
    expect(result.steps[0]?.held).toBe(true);
    expect(result.steps[0]?.contradictions?.map((c) => c.kind) ?? []).not.toContain(
      'ui-advanced-request-failed',
    );
    expect(result.verified).toBe('yes');
  });

  it('still answers no when the step did not declare the 409', async () => {
    if (sequence === undefined) {
      throw new Error('no act_sequence tool');
    }
    const result = (await sequence.handler(depsFor(refusedSaveSession()), {
      steps: [
        {
          ref: 'e1',
          action: 'click',
          expect: { kind: 'element', query: { text: 'x' }, absent: true },
        },
      ],
      timeout_ms: 2000,
    })) as Answer;
    expect(result.steps[0]?.contradictions?.map((c) => c.kind)).toContain(
      'ui-advanced-request-failed',
    );
    expect(result.verified).toBe('no');
  });
});
