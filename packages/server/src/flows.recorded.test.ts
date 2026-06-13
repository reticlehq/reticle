import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionType,
  AnchorKind,
  EventType,
  FLOW_FILE_VERSION,
  FlowErrorCode,
  RecordedSaveError,
  type CommandResult,
  type FlowFile,
  type IrisEvent,
} from '@iris/protocol';
import { createNodeFileSystem, type FileSystemPort } from './fs-port.js';
import { FlowStore } from './flows.js';
import { AnnotationStore } from './annotation-store.js';
import { FLOW_TOOLS } from './flow-tools.js';
import { IrisTool } from './tool-names.js';
import { BaselineStore } from './baselines.js';
import { RecordingStore } from './recordings.js';
import type { Session, SessionManager } from './session.js';
import type { ToolDeps } from './tools.js';

const FROZEN = 1234;
const clock = { now: (): number => FROZEN };

function flowFile(name: string, steps: FlowFile['steps']): FlowFile {
  return { version: FLOW_FILE_VERSION, name, createdAt: FROZEN, steps };
}

function clickStep(testid: string): FlowFile['steps'][number] {
  return {
    tool: IrisTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value: testid },
    action: ActionType.CLICK,
    args: {},
  };
}

function recordedEvent(name: string, flow: FlowFile): IrisEvent {
  return { t: 1, type: EventType.FLOW_RECORDED, sessionId: 's', data: { name, flow } };
}

describe('FlowStore.saveFlow (M8 Stage B) — temp-dir fs', () => {
  let root: string;
  let fs: FileSystemPort;
  let store: FlowStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iris-recorded-'));
    root = join(dir, '.iris');
    fs = createNodeFileSystem();
    store = new FlowStore(fs, root, clock);
  });

  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  it('S1: saveFlow writes a valid FlowFile and round-trips via load', async () => {
    const flow = flowFile('checkout', [clickStep('pay'), clickStep('confirm')]);
    const saved = await store.saveFlow(flow);
    expect(saved).toEqual({
      ok: true,
      value: { name: 'checkout', stepCount: 2, degraded: 0, empty: false },
    });
    const loaded = await store.load('checkout');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.steps).toHaveLength(2);
    expect(loaded.value.steps[0]?.anchor).toEqual({ kind: AnchorKind.TESTID, value: 'pay' });
  });

  it('S2: saveFlow rejects an unsafe name (no file written)', async () => {
    const flow = flowFile('../escape', [clickStep('pay')]);
    const saved = await store.saveFlow(flow);
    expect(saved).toEqual({ ok: false, code: FlowErrorCode.INVALID_NAME });
    expect(await store.list()).toEqual([]);
  });

  it('S3: saveFlow of an empty-steps flow → empty:true, still written', async () => {
    const flow = flowFile('empty', []);
    const saved = await store.saveFlow(flow);
    expect(saved).toEqual({
      ok: true,
      value: { name: 'empty', stepCount: 0, degraded: 0, empty: true },
    });
    expect(await store.list()).toEqual(['empty']);
  });
});

// ---- iris_flow_save_recorded handler ----

function fakeDeps(store: FlowStore, events: IrisEvent[]): ToolDeps {
  const command = (): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  const session: Partial<Session> = { id: 'demo', command, eventsSince: () => events };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: store,
    annotations: new AnnotationStore(),
    fs: createNodeFileSystem(),
    irisRoot: '/virtual/.iris',
    now: () => FROZEN,
  };
}

function recordedTool() {
  const t = FLOW_TOOLS.find((x) => x.name === IrisTool.FLOW_SAVE_RECORDED);
  if (t === undefined) throw new Error('no iris_flow_save_recorded tool');
  return t;
}

describe('iris_flow_save_recorded handler (M8 Stage B)', () => {
  let root: string;
  let store: FlowStore;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iris-recorded-tool-'));
    root = join(dir, '.iris');
    store = new FlowStore(createNodeFileSystem(), root, clock);
  });

  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  it('S4: reads the LAST FLOW_RECORDED event and persists it', async () => {
    const first = recordedEvent('first', flowFile('first', [clickStep('a')]));
    const last = recordedEvent('second', flowFile('second', [clickStep('b'), clickStep('c')]));
    const deps = fakeDeps(store, [first, last]);
    const res = (await recordedTool().handler(deps, {})) as { name: string; stepCount: number };
    expect(res.name).toBe('second');
    expect(res.stepCount).toBe(2);
    expect(await store.list()).toEqual(['second']);
  });

  it('S5: no FLOW_RECORDED in the buffer → { code: NO_RECORDED_FLOW }, nothing written', async () => {
    const deps = fakeDeps(store, []);
    const res = (await recordedTool().handler(deps, {})) as { code: string };
    expect(res.code).toBe(RecordedSaveError.NO_RECORDED_FLOW);
    expect(await store.list()).toEqual([]);
  });

  it('S6: malformed FLOW_RECORDED data → NO_RECORDED_FLOW (never throws)', async () => {
    const bad: IrisEvent = {
      t: 1,
      type: EventType.FLOW_RECORDED,
      sessionId: 's',
      data: { name: 'x', flow: { not: 'a flow' } },
    };
    const deps = fakeDeps(store, [bad]);
    const res = (await recordedTool().handler(deps, {})) as { code: string };
    expect(res.code).toBe(RecordedSaveError.NO_RECORDED_FLOW);
    expect(await store.list()).toEqual([]);
  });

  it('S7: name arg overrides the recorded flow name', async () => {
    const ev = recordedEvent('original', flowFile('original', [clickStep('a')]));
    const deps = fakeDeps(store, [ev]);
    const res = (await recordedTool().handler(deps, { name: 'renamed' })) as { name: string };
    expect(res.name).toBe('renamed');
    expect(await store.list()).toEqual(['renamed']);
  });
});
