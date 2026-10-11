/**
 * From a persona drive: a checkout click took the tab to the payment host on another origin, the
 * session closed behind it, and `act_and_wait` answered "sessionId … names no session" — an error
 * instead of a verdict, so the purchase click could never be proved or even graded. What happened
 * before the tab left is still evidence; the call answers with a verdict on what it could see.
 */
import { describe, expect, it } from 'vitest';
import {
  PredicateKind,
  ReticleCommand,
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

describe('a click that takes the tab off the app', () => {
  it('answers with a verdict, not a "names no session" error', async () => {
    const { deps, depart } = fakeApp();
    const act = TOOLS.find((t) => ReticleTool.ACT_AND_WAIT === t.name);
    const res = (await act?.handler(deps, {
      sessionId: 'lease-1',
      ref: 'e189',
      action: 'click',
      timeout_ms: 0,
      until: { kind: PredicateKind.NET, method: 'POST', urlContains: '/v1/billing/checkout' },
    })) as Record<string, unknown>;
    expect(depart()).toBe(true);
    expect(typeof res['verified']).toBe('string');
  });
});

/*
 * `reticle_assert { action: "wait" }` answered `pass: true` and no `verified`, while
 * `action: "now"` on the same predicate answered `verified: "yes"`: one tool, two answer shapes,
 * and the field an agent is told to gate on missing from one of them.
 */
describe('reticle_assert { action: "wait" }', () => {
  it('answers with the verdict field an agent gates on, as "now" does', async () => {
    const { deps } = fakeApp();
    const wait = TOOLS.find((t) => ReticleTool.WAIT_FOR === t.name);
    const res = (await wait?.handler(deps, {
      predicate: { kind: PredicateKind.SETTLED },
      timeout_ms: 0,
    })) as Record<string, unknown>;
    expect(typeof res['verified']).toBe('string');
    expect(typeof res['because']).toBe('string');
  });
});

function fakeApp(): { deps: ToolDeps; depart: () => boolean } {
  let departed = false;
  const command = (name: string): Promise<CommandResult> => {
    if (ReticleCommand.ACT === name) departed = true;
    return Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: ReticleCommand.ACT === name ? { dispatched: true, settled: true } : {},
    });
  };
  const none: ReticleEvent[] = [];
  const session = {
    id: 'lease-1',
    url: 'http://localhost:16581/settings',
    elapsed: () => 1000,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    recordAction: () => 'a2',
    command,
    queryEvents: () => Promise.resolve(none),
    eventsSince: () => none,
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
  } as unknown as Session;
  const sessions = {
    resolve: (id?: string) => {
      if (departed && id !== undefined) throw new Error(`no connected session with id '${id}'`);
      return session;
    },
    get: () => undefined,
    all: () => [],
  } as unknown as SessionManager;
  const root = '/tmp/reticle-test-leaves-origin/.reticle';
  const deps: ToolDeps = {
    sessions,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(createNodeFileSystem(), root, { now: () => 0 }),
    project: new ProjectStore(createNodeFileSystem(), root, { now: () => 0 }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: root,
    now: () => 0,
  };
  return { deps, depart: () => departed };
}
