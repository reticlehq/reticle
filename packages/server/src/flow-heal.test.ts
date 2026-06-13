import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionType,
  AnchorKind,
  DriftReason,
  FLOW_FILE_VERSION,
  RebindStatus,
  ReplayStatus,
  type CommandResult,
  type ElementDescriptor,
  type FlowFile,
  type FlowStepResult,
  type IrisEvent,
  type QueryEmptyHint,
} from '@iris/protocol';
import { buildProposals } from './flow-heal.js';
import { FLOW_TOOLS } from './flow-tools.js';
import { IrisTool } from './tool-names.js';
import { FlowStore } from './flows.js';
import { createNodeFileSystem } from './fs-port.js';
import { BaselineStore } from './baselines.js';
import { RecordingStore } from './recordings.js';
import { asString } from './tools-helpers.js';
import { IrisCommand } from '@iris/protocol';
import type { Session, SessionManager } from './session.js';
import type { ToolDeps } from './tools.js';

const FROZEN = 1234;
const clock = { now: (): number => FROZEN };

// ---- buildProposals (pure) ----

function driftStep(step: number, anchor: string, nearest: string | null): FlowStepResult {
  return {
    step,
    tool: IrisTool.ACT,
    anchor,
    ok: false,
    drift: {
      reasonKind: DriftReason.TESTID_NOT_FOUND,
      reason: `testid "${anchor}" not found`,
      anchor,
      nearest,
    },
  };
}

function okStep(step: number, anchor: string): FlowStepResult {
  return { step, tool: IrisTool.ACT, anchor, ok: true };
}

describe('buildProposals — pure proposal building (M8 Stage B self-heal)', () => {
  it('H1p: a drift with a nearest match → status proposed when apply=false', () => {
    const proposals = buildProposals([driftStep(0, 'chat-send', 'chat-submit')], false);
    expect(proposals).toEqual([
      { step: 0, from: 'chat-send', to: 'chat-submit', status: RebindStatus.PROPOSED },
    ]);
  });

  it('H2p: apply=true marks the proposal applied', () => {
    const proposals = buildProposals([driftStep(0, 'chat-send', 'chat-submit')], true);
    expect(proposals[0]?.status).toBe(RebindStatus.APPLIED);
  });

  it('H3p: a drift with no nearest match → status none (never silent)', () => {
    const proposals = buildProposals([driftStep(0, 'gone', null)], true);
    expect(proposals).toEqual([{ step: 0, from: 'gone', to: 'gone', status: RebindStatus.NONE }]);
  });

  it('H4p: an all-green replay → no proposals', () => {
    expect(buildProposals([okStep(0, 'a'), okStep(1, 'b')], false)).toEqual([]);
  });

  it('H6p: multi-drift → one proposal per drifted step in order', () => {
    const proposals = buildProposals(
      [driftStep(0, 'a-old', 'a-new'), driftStep(1, 'b-old', 'b-new')],
      false,
    );
    expect(proposals.map((p) => p.step)).toEqual([0, 1]);
    expect(proposals.map((p) => p.to)).toEqual(['a-new', 'b-new']);
  });
});

// ---- iris_flow_heal tool ----

interface QueryScript {
  elements: ElementDescriptor[];
  hint?: QueryEmptyHint;
}

function el(ref: string, testid: string): ElementDescriptor {
  return { ref, role: 'button', name: testid, states: [], visible: true };
}

function present(testids: string[]): QueryEmptyHint {
  return { route: '/', presentTestids: testids, knownEmptyState: false };
}

class FakeSession {
  readonly acts: string[] = [];
  constructor(private readonly script: (testid: string) => QueryScript) {}
  command(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    if (name === IrisCommand.QUERY) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: this.script(asString(args['value']) ?? ''),
      });
    }
    if (name === IrisCommand.ACT) {
      this.acts.push(asString(args['ref']) ?? '');
      return Promise.resolve({ kind: 'command_result', id: 'a', ok: true, result: {} });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }
  eventsSince(): IrisEvent[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
}

function clickStep(testid: string): FlowFile['steps'][number] {
  return {
    tool: IrisTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value: testid },
    action: ActionType.CLICK,
    args: {},
  };
}

function flowFile(name: string, steps: FlowFile['steps']): FlowFile {
  return { version: FLOW_FILE_VERSION, name, createdAt: FROZEN, steps };
}

function fakeDeps(store: FlowStore, session: FakeSession): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => session as unknown as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: store,
    fs: createNodeFileSystem(),
    irisRoot: '/virtual/.iris',
    now: () => FROZEN,
  };
}

function healTool() {
  const t = FLOW_TOOLS.find((x) => x.name === IrisTool.FLOW_HEAL);
  if (t === undefined) throw new Error('no iris_flow_heal tool');
  return t;
}

describe('iris_flow_heal handler (M8 Stage B self-heal)', () => {
  let root: string;
  let store: FlowStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iris-heal-'));
    root = join(dir, '.iris');
    store = new FlowStore(createNodeFileSystem(), root, clock);
  });

  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  it('H1: drift with a nearest match → proposed, not applied; disk unchanged', async () => {
    await store.saveFlow(flowFile('chat', [clickStep('chat-send')]));
    const session = new FakeSession((testid) =>
      testid === 'chat-send'
        ? { elements: [], hint: present(['chat-submit']) }
        : { elements: [el(`e-${testid}`, testid)] },
    );
    const res = (await healTool().handler(fakeDeps(store, session), { name: 'chat' })) as {
      status: string;
      proposals: { from: string; to: string; status: string }[];
      applied: boolean;
    };
    expect(res.status).toBe(ReplayStatus.DRIFT);
    expect(res.applied).toBe(false);
    expect(res.proposals).toEqual([
      { step: 0, from: 'chat-send', to: 'chat-submit', status: RebindStatus.PROPOSED },
    ]);
    // disk untouched
    const loaded = await store.load('chat');
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.steps[0]?.anchor).toEqual({ kind: AnchorKind.TESTID, value: 'chat-send' });
  });

  it('H2: apply:true rebinds the anchor on disk', async () => {
    await store.saveFlow(flowFile('chat', [clickStep('chat-send')]));
    const session = new FakeSession((testid) =>
      testid === 'chat-send'
        ? { elements: [], hint: present(['chat-submit']) }
        : { elements: [el(`e-${testid}`, testid)] },
    );
    const res = (await healTool().handler(fakeDeps(store, session), {
      name: 'chat',
      apply: true,
    })) as { applied: boolean; proposals: { status: string }[] };
    expect(res.applied).toBe(true);
    expect(res.proposals[0]?.status).toBe(RebindStatus.APPLIED);
    const loaded = await store.load('chat');
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.steps[0]?.anchor).toEqual({
      kind: AnchorKind.TESTID,
      value: 'chat-submit',
    });
  });

  it('H3: drift with no nearest match → status none, applied false, replay status drift', async () => {
    await store.saveFlow(flowFile('chat', [clickStep('chat-send')]));
    const session = new FakeSession(() => ({ elements: [], hint: present([]) }));
    const res = (await healTool().handler(fakeDeps(store, session), {
      name: 'chat',
      apply: true,
    })) as { status: string; applied: boolean; proposals: { status: string }[] };
    expect(res.status).toBe(ReplayStatus.DRIFT);
    expect(res.applied).toBe(false);
    expect(res.proposals[0]?.status).toBe(RebindStatus.NONE);
  });

  it('H4: a green replay → no proposals, status ok', async () => {
    await store.saveFlow(flowFile('chat', [clickStep('chat-send')]));
    const session = new FakeSession((testid) => ({ elements: [el(`e-${testid}`, testid)] }));
    const res = (await healTool().handler(fakeDeps(store, session), { name: 'chat' })) as {
      status: string;
      proposals: unknown[];
    };
    expect(res.status).toBe(ReplayStatus.OK);
    expect(res.proposals).toEqual([]);
  });

  it('H5: heal of a missing flow → status error, no proposals', async () => {
    const session = new FakeSession(() => ({ elements: [] }));
    const res = (await healTool().handler(fakeDeps(store, session), { name: 'nope' })) as {
      status: string;
      proposals: unknown[];
    };
    expect(res.status).toBe(ReplayStatus.ERROR);
    expect(res.proposals).toEqual([]);
  });

  it('H7: rebindAnchor only touches the targeted testid step', async () => {
    await store.saveFlow(
      flowFile('multi', [clickStep('keep-a'), clickStep('chat-send'), clickStep('keep-b')]),
    );
    const before = await store.load('multi');
    if (!before.ok) throw new Error('expected ok');
    const rebind = await store.rebindAnchor('multi', 1, 'chat-submit');
    expect(rebind.ok).toBe(true);
    const after = await store.load('multi');
    if (!after.ok) throw new Error('expected ok');
    expect(after.value.steps[0]?.anchor).toEqual(before.value.steps[0]?.anchor);
    expect(after.value.steps[2]?.anchor).toEqual(before.value.steps[2]?.anchor);
    expect(after.value.steps[1]?.anchor).toEqual({ kind: AnchorKind.TESTID, value: 'chat-submit' });
  });
});
