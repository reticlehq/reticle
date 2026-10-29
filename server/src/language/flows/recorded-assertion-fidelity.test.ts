/**
 * A saved flow checks exactly what the agent asserted while it recorded (#988).
 *
 * Shipped defect: the recorder saved flows whose assertions were dropped, reversed or de-scoped, so
 * the flow replayed with no check, or with the wrong one, and passed on a broken app. These tests
 * drive the REAL tools (`record start`, `act_and_wait`, `record stop`, `flow_save`), read the saved
 * file, and replay it against a page that does not meet the claim. A test over a hand-built step
 * passes while the tool path drops the claim, which is how the defect survived.
 */
import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReplayStatus,
  ReticleCommand,
  ReticleTool,
  SessionState,
  type CommandResult,
  type FlowFile,
  type ReticleEvent,
} from '@reticlehq/core';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { LastAct } from '@/portal/session/last-act.js';
import { RAW_TOOLS, type ToolDeps } from '@/surface/tools/tools.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { RecordingStore, ambientRecordingOf } from './recording/tape/recordings.js';
import { FlowStore } from './flows.js';
import { AnnotationStore } from './stores/annotation-store.js';
import { replayFlow } from './flow-replay.js';
import { replayVerdictEffect } from './flow-result.js';

const SESSION = 's1';
const REPLAY_WAIT_MS = 60;

/**
 * A page as a set of facts: `testid:x` is an element on it, `text:Paid@#row-3` is that text inside
 * that scope. The fake answers MATCH, QUERY and ACT from it, so a step's effect is a change to it.
 */
class FakePage {
  readonly facts = new Set<string>();
  readonly events: ReticleEvent[] = [];
  clock = 1000;
  /** An act that leaves no event in the window, so the verdict cannot be a clean yes. */
  quiet = false;
  constructor(readonly onAct: Record<string, (page: FakePage) => void> = {}) {}

  matches(query: Record<string, unknown>): boolean {
    const testid = query['testid'];
    if ('string' === typeof testid) {
      return this.facts.has(`testid:${testid}`);
    }
    const text = query['text'];
    if ('string' !== typeof text) {
      return false;
    }
    const scope = query['scope'];
    if ('string' === typeof scope) {
      return this.facts.has(`text:${text}@${scope}`);
    }
    return [...this.facts].some((f) => f === `text:${text}` || f.startsWith(`text:${text}@`));
  }

  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    const ok = (result: unknown): Promise<CommandResult> =>
      Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result } as CommandResult);
    const el = { ref: 'e9', role: 'button', name: 'x', states: [], visible: true };
    if (ReticleCommand.MATCH === name) {
      const hit = this.matches((args['query'] ?? {}) as Record<string, unknown>);
      return ok({ matched: hit, count: hit ? 1 : 0, elements: hit ? [el] : [] });
    }
    if (ReticleCommand.QUERY === name) {
      // A replay resolves its testid anchor to the ref the recording acted on, so `onAct` fires.
      const value = String(args['value']);
      const ref =
        this.targets[value] ??
        Object.keys(this.actResult).find((r) => this.actResult[r]?.['testid'] === value);
      const hit = this.facts.has(`testid:${value}`) || this.targets[value] !== undefined;
      return ok({ elements: hit ? [{ ...el, ref: ref ?? `e-${value}` }] : [] });
    }
    if (ReticleCommand.ACT === name) {
      const ref = String(args['ref']);
      this.onAct[ref]?.(this);
      if (!this.quiet) {
        this.events.push({ type: 'dom.added', t: this.clock, data: {} } as unknown as ReticleEvent);
      }
      return ok(this.actResult[ref] ?? {});
    }
    return ok({});
  }

  /** What the SDK reports about the acted element, by ref. */
  actResult: Record<string, Record<string, unknown>> = {};
  /** The ref a `target` query resolves to, by the query's `value` (a role, a testid). */
  targets: Record<string, string> = {};

  eventsSince(since: number): ReticleEvent[] {
    return this.events.filter((e) => e.t >= since);
  }
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reticle-fidelity-'));
});
afterEach(async () => removeTempDir(root));

function depsFor(page: FakePage): { deps: ToolDeps; recordings: RecordingStore } {
  const stub: Partial<Session> = {
    id: SESSION,
    url: 'http://localhost:5173/app',
    elapsed: () => (page.clock += 10),
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    command: (name, args) => page.command(name, args),
    queryEvents: () => Promise.resolve([]),
    eventsSince: (since: number) => page.eventsSince(since),
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
  const session = stub as Session;
  const fs = createNodeFileSystem();
  const clock = { now: (): number => 0 };
  const recordings = new RecordingStore();
  const deps = {
    sessions: { resolve: () => session } as unknown as SessionManager,
    baselines: new BaselineStore(),
    recordings,
    flows: new FlowStore(fs, root, clock),
    project: new ProjectStore(fs, root, clock),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: root,
    now: clock.now,
  } as ToolDeps;
  return { deps, recordings };
}

function tool(name: string) {
  const found = RAW_TOOLS.find((t) => t.name === name);
  if (found === undefined) {
    throw new Error(`no ${name} tool`);
  }
  return found;
}

const run = (deps: ToolDeps, name: string, args: Record<string, unknown>): Promise<unknown> =>
  tool(name).handler(deps, args);

/** One act_and_wait on `ref`, recorded as the tool path records it. */
const actAndWait = (
  deps: ToolDeps,
  ref: string,
  until: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<unknown> =>
  run(deps, ReticleTool.ACT_AND_WAIT, { ref, action: 'click', timeout_ms: 0, until, ...extra });

/** record start → drive → record stop → flow_save, and the flow file it wrote. */
async function recordAndSave(
  deps: ToolDeps,
  drive: () => Promise<unknown>,
): Promise<{ flow: FlowFile; stopped: Record<string, unknown>; saved: Record<string, unknown> }> {
  await run(deps, ReticleTool.RECORD_START, { recordingName: 'journey' });
  await drive();
  const stopped = (await run(deps, ReticleTool.RECORD_STOP, {
    recordingName: 'journey',
  })) as Record<string, unknown>;
  const saved = (await run(deps, ReticleTool.FLOW_SAVE, { flowName: 'journey' })) as Record<
    string,
    unknown
  >;
  const flow = JSON.parse(await readFile(join(root, 'flows', 'journey.json'), 'utf8')) as FlowFile;
  return { flow, stopped, saved };
}

/** Replay a saved flow on a fresh page and say whether every step held. */
async function replaysGreen(flow: FlowFile, page: FakePage): Promise<boolean> {
  const steps = await replayFlow(
    {
      command: (name, args) => page.command(name, args),
      eventsSince: (since) => page.eventsSince(since),
      onEvent: () => () => undefined,
      elapsed: () => (page.clock += 10),
    },
    { ...flow, startPath: undefined },
    waitForPredicate,
    REPLAY_WAIT_MS,
  );
  return steps.every((s) => s.ok);
}

/** The recorded click on `save`, anchored by its testid. */
const saveButton = (page: FakePage): void => {
  page.facts.add('testid:save');
  page.actResult['e4'] = { testid: 'save' };
};

describe('#988 dropped: a declared `until` reaches the saved flow', () => {
  it('keeps visible and absent text claims that held', async () => {
    const page = new FakePage({
      e4: (p) => {
        p.facts.add('text:Saved');
        p.facts.delete('text:Unsaved changes');
      },
    });
    saveButton(page);
    page.facts.add('text:Unsaved changes');
    const { deps } = depsFor(page);
    const visible = { kind: 'text', text: 'Saved' };
    const absent = { kind: 'text', text: 'Unsaved changes', absent: true };
    const { flow, saved } = await recordAndSave(deps, async () => {
      await actAndWait(deps, 'e4', { kind: 'allOf', predicates: [visible, absent] });
    });
    expect(flow.steps[0]?.expect).toEqual({
      kind: 'allOf',
      predicates: [
        { kind: 'text', contains: 'Saved' },
        { kind: 'text', contains: 'Unsaved changes', absent: true },
      ],
    });
    expect(asRecord(saved['assertions'])['grade']).not.toBe('assertion-free');
  });

  it('keeps a claim the action made hold when the verdict was not a clean yes', async () => {
    // The window records no event, so the verdict is `unknown`, though the banner appeared.
    const page = new FakePage({ e4: (p) => p.facts.add('testid:banner') });
    page.quiet = true;
    const { deps, recordings } = depsFor(page);
    const until = { kind: 'element', query: { testid: 'banner' } };
    const res = asRecord(await actAndWait(deps, 'e4', until));
    expect(res['verified']).not.toBe('yes');
    expect(recordings.takeAmbient(SESSION)?.steps[0]?.expect).toEqual(until);
  });

  it('keeps an already-true claim in a recording somebody opened', async () => {
    const page = new FakePage();
    saveButton(page);
    page.facts.add('testid:banner');
    const { deps, recordings } = depsFor(page);
    const until = { kind: 'element', query: { testid: 'banner' } };
    const { flow } = await recordAndSave(deps, () => actAndWait(deps, 'e4', until));
    expect(flow.steps[0]?.expect).toEqual(until);
    // The ambient tape leaves it off: the action did not make it hold.
    expect(recordings.takeAmbient(SESSION)?.steps[0]?.expect).toBeUndefined();
  });

  it('keeps a refuted claim in a recording somebody opened, so the flow stays red', async () => {
    const page = new FakePage();
    saveButton(page);
    const { deps } = depsFor(page);
    const until = { kind: 'element', query: { testid: 'receipt' } };
    const { flow } = await recordAndSave(deps, () => actAndWait(deps, 'e4', until));
    expect(flow.steps[0]?.expect).toEqual(until);
    expect(await replaysGreen(flow, page)).toBe(false);
  });

  it('keeps a passing step’s claim on the ambient tape when the NEXT step fails', async () => {
    const page = new FakePage({ e4: (p) => p.facts.add('testid:saved') });
    const { deps, recordings } = depsFor(page);
    await actAndWait(deps, 'e4', { kind: 'element', query: { testid: 'saved' } });
    await actAndWait(deps, 'e5', { kind: 'element', query: { testid: 'never' } });
    const steps = recordings.takeAmbient(SESSION)?.steps ?? [];
    expect(steps).toHaveLength(2);
    expect(steps[0]?.expect).toEqual({ kind: 'element', query: { testid: 'saved' } });
    // A claim that never held stays off the tape an auto-saved flow is cut from.
    expect(steps[1]?.expect).toBeUndefined();
    expect(recordings.isRecording(ambientRecordingOf(SESSION))).toBe(false);
  });
});

describe('#988 reversed: an absence claim is saved and replayed as an absence', () => {
  const spinner = { kind: 'element', query: { testid: 'spinner' }, absent: true };

  it('saves `absent: true` and goes red when the element is still there', async () => {
    const page = new FakePage({ e4: (p) => p.facts.delete('testid:spinner') });
    saveButton(page);
    page.facts.add('testid:spinner');
    const { deps } = depsFor(page);
    const { flow } = await recordAndSave(deps, () => actAndWait(deps, 'e4', spinner));
    expect(flow.steps[0]?.expect).toEqual(spinner);

    const broken = new FakePage();
    saveButton(broken);
    broken.facts.add('testid:spinner');
    expect(await replaysGreen(flow, broken)).toBe(false);

    const working = new FakePage({ e4: (p) => p.facts.delete('testid:spinner') });
    saveButton(working);
    working.facts.add('testid:spinner');
    expect(await replaysGreen(flow, working)).toBe(true);
  });

  it('keeps the flat element form absent too', async () => {
    const page = new FakePage({ e4: (p) => p.facts.delete('testid:spinner') });
    saveButton(page);
    page.facts.add('testid:spinner');
    const { deps } = depsFor(page);
    const { flow } = await recordAndSave(deps, () =>
      actAndWait(deps, 'e4', { kind: 'element', testid: 'spinner', absent: true }),
    );
    expect(flow.steps[0]?.expect).toEqual(spinner);
  });
});

describe('#988 de-scoped: a scoped claim keeps its scope', () => {
  const paidInRow = { kind: 'text', contains: 'Paid', scope: '#row-3' };

  it('saves the scope and goes red when the text is only in another row', async () => {
    const page = new FakePage({ e4: (p) => p.facts.add('text:Paid@#row-3') });
    saveButton(page);
    const { deps } = depsFor(page);
    const { flow } = await recordAndSave(deps, () => actAndWait(deps, 'e4', paidInRow));
    expect(flow.steps[0]?.expect).toEqual(paidInRow);

    const wrongRow = new FakePage({ e4: (p) => p.facts.add('text:Paid@#row-1') });
    saveButton(wrongRow);
    expect(await replaysGreen(flow, wrongRow)).toBe(false);
  });

  it('keeps an acted target’s position among namesakes', async () => {
    // `target: { role, name, scope }` picked the third of eight `Details` buttons.
    const page = new FakePage();
    page.actResult['e30'] = { role: 'button', name: 'Details', nth: 2, of: 8 };
    page.targets['button'] = 'e30';
    const { deps } = depsFor(page);
    const { flow } = await recordAndSave(deps, () =>
      run(deps, ReticleTool.ACT_AND_WAIT, {
        target: { role: 'button', name: 'Details', scope: '#row-3' },
        action: 'click',
        timeout_ms: 0,
        until: { kind: 'text', contains: 'Paid', scope: '#row-3' },
      }),
    );
    expect(flow.steps[0]?.anchor).toEqual({
      kind: 'role',
      role: 'button',
      name: 'Details',
      nth: 2,
      of: 8,
    });
  });

  it('says so when a scope is a session ref, and the flow is graded assertion-free', async () => {
    const page = new FakePage({ e4: (p) => p.facts.add('text:Paid@e12') });
    saveButton(page);
    const { deps } = depsFor(page);
    const { flow, stopped, saved } = await recordAndSave(deps, () =>
      actAndWait(deps, 'e4', { kind: 'text', contains: 'Paid', scope: 'e12' }),
    );
    expect(flow.steps[0]?.expect).toBeUndefined();
    expect(String(stopped['warning'])).toContain('does not keep');
    expect(asRecord(saved['assertions'])['grade']).toBe('assertion-free');
    // A replay of a flow that checks nothing is never reported as a verified pass.
    expect(replayVerdictEffect('journey', ReplayStatus.OK, true).verified).not.toBe('yes');
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  return 'object' === typeof value && null !== value ? (value as Record<string, unknown>) : {};
}
