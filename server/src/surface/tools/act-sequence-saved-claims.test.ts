/**
 * A journey whose claims all held is saved with every claim.
 *
 * Reported from the field: `reticle_flow_save` after a four-step `reticle_act { steps }` journey
 * graded the flow as having no consequence assertion, while the journey itself answered
 * `verified: yes` for four declared consequences. A saved flow without the claims cannot catch the
 * regression the journey once caught. These tests drive the journey through the real handler and
 * save it the ways an agent does: the recording the keep offer names, a recording the agent opened,
 * and the ambient tape that session end saves.
 *
 * The ambient tape was the path that lost them: session end read only a tape step's own `expect`,
 * and a journey's claims are on its sub-steps, so the journey was not saved at all.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EventType,
  ReticleCommand,
  ReticleTool,
  SessionState,
  Verified,
  type CommandResult,
  type FlowStep,
  type ReticleEvent,
} from '@reticlehq/core';
import { LastAct } from '@/portal/session/last-act.js';
import { TOOLS, type ToolDeps } from './tools.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { classifyFlowAssertions } from '@/language/flows/flow-classify.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import { driveFlowsFrom } from '@/memory/journal/drive-flow.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { LIVE_CONTROL_TOOLS } from '@/portal/session/live-control-tools.js';
import { JOURNEY_RECORDING } from './act/sequence-grade.js';

const ORIGIN = 'http://localhost:5173';
const SAVED_AS = 'four-claims';

/**
 * A page where every click sends one POST that answers 200 and emits one signal, both numbered by
 * the click. `pages` is the path the tab is on after each click: a click can move the app.
 */
function answeringSession(id: string, pages: readonly string[] = []): Session {
  const start = Date.now();
  const clock = (): number => Date.now() - start;
  const events: ReticleEvent[] = [];
  let path = '/shop';
  const push = (type: EventType, data: Record<string, unknown>): void => {
    events.push({ t: clock(), type, sessionId: id, data });
  };
  const command = (name: string, args?: Record<string, unknown>): Promise<CommandResult> => {
    const ref = args?.['ref'];
    if (ReticleCommand.ACT !== name || 'string' !== typeof ref) {
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
    }
    // The click on `eN` is step N of the journey.
    const n = ref.slice(1);
    push(EventType.NET_REQUEST, {
      id: `r${n}`,
      method: 'POST',
      url: `${ORIGIN}/api/step/${n}`,
      status: 200,
      ok: true,
      durationMs: 1,
      initiator: 'fetch',
    });
    push(EventType.SIGNAL, { name: `step:${n}` });
    path = pages[Number(n) - 1] ?? path;
    return Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: {
        ref: `e${n}`,
        action: 'click',
        dispatched: true,
        settled: true,
        settleReason: null,
        testid: `step-${n}`,
      },
    });
  };
  const stub: Partial<Session> = {
    id,
    get url() {
      return `${ORIGIN}${path}`;
    },
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
    onEvent: () => () => undefined,
  };
  return stub as Session;
}

function depsFor(session: Session, recordings: RecordingStore, flows: FlowStore): ToolDeps {
  const sessions: Partial<SessionManager> = {
    resolve: () => session,
    get: () => session,
    count: () => 1,
    departed: () => undefined,
  };
  const root = join(mkdtempSync(join(tmpdir(), 'reticle-saved-claims-')), '.reticle');
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings,
    flows,
    project: new ProjectStore(createNodeFileSystem(), root, { now: () => 0 }),
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    reticleRoot: root,
    now: () => 0,
  };
}

function freshFlows(): FlowStore {
  const root = join(mkdtempSync(join(tmpdir(), 'reticle-saved-claims-')), '.reticle');
  return new FlowStore(createNodeFileSystem(), root, { now: () => 0 });
}

function tool(name: string) {
  const found = [...TOOLS, ...LIVE_CONTROL_TOOLS].find((t) => t.name === name);
  if (found === undefined) {
    throw new Error(`no ${name} tool`);
  }
  return found;
}

const click = (n: number): Record<string, unknown> => ({ ref: `e${String(n)}`, action: 'click' });
const signalled = (n: number): Record<string, unknown> => ({
  ...click(n),
  expect: { kind: 'signal', name: `step:${String(n)}` },
});
const posted = (n: number): Record<string, unknown> => ({
  ...click(n),
  expect: {
    kind: 'net',
    method: 'POST',
    urlContains: `/api/step/${String(n)}`,
    status: 200,
  },
});

interface Saved {
  assertions?: { hasConsequenceAssertion: boolean; consequenceSteps: number; totalSteps: number };
  error?: string;
}

/** The `expect` of each saved sub-step, in order. */
async function savedSubExpects(flows: FlowStore, name: string): Promise<unknown[]> {
  const loaded = await flows.load(name);
  if (!loaded.ok) {
    throw new Error(`flow ${name} did not load`);
  }
  const subs: FlowStep[] = loaded.value.steps.flatMap((step) => step.steps ?? []);
  return subs.map((sub) => sub.expect);
}

async function driveAndKeep(steps: Record<string, unknown>[], pages: readonly string[] = []) {
  const recordings = new RecordingStore();
  const flows = freshFlows();
  const session = answeringSession('s-claims', pages);
  const deps = depsFor(session, recordings, flows);
  const result = (await tool(ReticleTool.ACT_SEQUENCE).handler(deps, {
    steps,
    timeout_ms: 500,
  })) as { verified?: string; keep?: string };
  return { result, deps, flows, recordings };
}

describe('a journey whose claims held keeps every claim when it is saved', () => {
  const declared = (steps: Record<string, unknown>[]): unknown[] =>
    steps.filter((s) => s['expect'] !== undefined).map((s) => s['expect']);

  it.each([
    ['four held signals', [signalled(1), signalled(2), signalled(3), signalled(4)]],
    ['four held POSTs answered 200', [posted(1), posted(2), posted(3), posted(4)]],
    ['a first step that declares nothing', [click(1), posted(2), posted(3), posted(4), posted(5)]],
    ['an undeclared step in the middle', [posted(1), posted(2), click(3), posted(4), posted(5)]],
  ])('saves the keep offer`s recording with %s', async (_shape, steps) => {
    const { result, deps, flows } = await driveAndKeep(steps);
    expect(result.verified).toBe(Verified.YES);
    expect(result.keep).toContain(JOURNEY_RECORDING);
    const saved = (await tool(ReticleTool.FLOW_SAVE).handler(deps, {
      flowName: JOURNEY_RECORDING,
      saveAs: SAVED_AS,
    })) as Saved;
    expect(saved.error).toBeUndefined();
    const subs = await savedSubExpects(flows, SAVED_AS);
    expect(subs.filter((e) => e !== undefined)).toEqual(declared(steps));
    expect(saved.assertions).toMatchObject({
      hasConsequenceAssertion: true,
      consequenceSteps: 4,
      totalSteps: steps.length + 1,
    });
  });

  it('saves every claim when a click moves the app to another page', async () => {
    const steps = [posted(1), posted(2), posted(3), posted(4)];
    const { result, deps, flows } = await driveAndKeep(steps, ['/cart', '/shipping', '/payment']);
    expect(result.verified).toBe(Verified.YES);
    const saved = (await tool(ReticleTool.FLOW_SAVE).handler(deps, {
      flowName: JOURNEY_RECORDING,
      saveAs: SAVED_AS,
    })) as Saved;
    expect(await savedSubExpects(flows, SAVED_AS)).toEqual(declared(steps));
    expect(saved.assertions?.consequenceSteps).toBe(4);
  });

  it('saves every claim from a recording the agent opened', async () => {
    const recordings = new RecordingStore();
    const flows = freshFlows();
    const session = answeringSession('s-claims-deliberate');
    const deps = depsFor(session, recordings, flows);
    await tool(ReticleTool.RECORD).handler(deps, { action: 'start', recordingName: 'checkout' });
    const steps = [posted(1), signalled(2), posted(3), signalled(4)];
    await tool(ReticleTool.ACT_SEQUENCE).handler(deps, { steps, timeout_ms: 500 });
    await tool(ReticleTool.RECORD).handler(deps, { action: 'stop', recordingName: 'checkout' });
    const saved = (await tool(ReticleTool.FLOW_SAVE).handler(deps, {
      flowName: 'checkout',
      saveAs: SAVED_AS,
    })) as Saved;
    expect(saved.error).toBeUndefined();
    expect(await savedSubExpects(flows, SAVED_AS)).toEqual(declared(steps));
    expect(saved.assertions?.consequenceSteps).toBe(4);
  });

  it('saves every claim from the ambient tape, as session end does', async () => {
    const steps = [click(1), posted(2), posted(3), posted(4), posted(5)];
    const { recordings, flows } = await driveAndKeep(steps);
    const { programs } = driveFlowsFrom(recordings.takeAmbient('s-claims'));
    expect(programs).toHaveLength(1);
    const program = programs[0];
    if (program === undefined) {
      throw new Error('no program');
    }
    const res = await flows.saveJourney(program, undefined, 'drive-');
    if (!res.ok) {
      throw new Error('the journey did not save');
    }
    expect(await savedSubExpects(flows, res.value.name)).toEqual([undefined, ...declared(steps)]);
    const loaded = await flows.load(res.value.name);
    if (!loaded.ok) {
      throw new Error('the journey did not load');
    }
    expect(classifyFlowAssertions(loaded.value).consequenceSteps).toBe(4);
  });

  it('still drops a refuted claim from the ambient tape', async () => {
    const steps = [
      posted(1),
      posted(2),
      { ...click(3), expect: { kind: 'signal', name: 'never' } },
    ];
    const { recordings } = await driveAndKeep(steps);
    const taped = recordings.takeAmbient('s-claims')?.steps[0];
    const subs = (taped?.args as { steps?: { expect?: unknown }[] } | undefined)?.steps ?? [];
    expect(subs.map((s) => s.expect)).toEqual([
      posted(1)['expect'],
      posted(2)['expect'],
      undefined,
    ]);
  });
});
