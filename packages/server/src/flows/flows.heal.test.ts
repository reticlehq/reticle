import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  FLOW_SIGNAL_TIMEOUT_MS,
  FlowErrorCode,
  FlowFileSchema,
  HealStatus,
  IrisCommand,
  type CommandResult,
  type ElementDescriptor,
  type FlowFile,
  type FlowHealResult,
  type IrisEvent,
  type QueryEmptyHint,
} from '@syrin/iris-protocol';
import { FLOW_TOOLS } from './flow-tools.js';
import { IrisTool } from '../tools/tool-names.js';
import { FlowStore } from './flows.js';
import { ProjectStore } from '../project/project-store.js';
import { replayFlow } from './flow-replay.js';
import { waitForPredicate } from '../events/predicate.js';
import { AnnotationStore } from './annotation-store.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore } from './recordings.js';
import { asString } from '../tools/tools-helpers.js';
import { flowPath } from '../project/iris-dir.js';
import type { FileSystemPort } from '../project/fs-port.js';
import type { Session, SessionManager } from '../session/session.js';
import type { ToolDeps } from '../tools/tools.js';

const FROZEN = 1234;
const clock = { now: (): number => FROZEN };

interface QueryScript {
  elements: ElementDescriptor[];
  hint?: QueryEmptyHint;
}

function el(ref: string, testid: string): ElementDescriptor {
  return { ref, role: 'button', name: testid, states: [], visible: true };
}

function present(testids: string[]): QueryEmptyHint {
  return { route: '/', presentTestids: testids, presentRegions: [], knownEmptyState: false };
}

class FakeSession {
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
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  }
  eventsSince(): IrisEvent[] {
    return [];
  }
  onEvent(): () => void {
    return () => undefined;
  }
}

/** A session where `old` resolves to 0 elements with `present`, and any other testid resolves to 1. */
function renamedSession(old: string, presentTestids: string[]): FakeSession {
  return new FakeSession((testid) =>
    testid === old
      ? { elements: [], hint: present(presentTestids) }
      : { elements: [el(`e-${testid}`, testid)] },
  );
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
    project: new ProjectStore(createNodeFileSystem(), '/virtual/.iris', { now: () => FROZEN }),
    annotations: new AnnotationStore(),
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

async function heal(
  store: FlowStore,
  session: FakeSession,
  args: Record<string, unknown>,
): Promise<FlowHealResult> {
  return (await healTool().handler(fakeDeps(store, session), args)) as FlowHealResult;
}

describe('FlowStore.heal + iris_flow_heal', () => {
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

  it('heal apply:true rewrites a renamed testid and a subsequent replay is green', async () => {
    await store.saveFlow(flowFile('chat', [clickStep('old-id')]));
    const session = renamedSession('old-id', ['new-id']);

    const res = await heal(store, session, { flowName: 'chat', apply: true });
    expect(res.status).toBe(HealStatus.HEALED);
    expect(res.applied).toBe(true);
    expect(res.changed).toEqual([{ step: 0, from: 'old-id', to: 'new-id' }]);

    const loaded = await store.load('chat');
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.steps[0]?.anchor).toEqual({ kind: AnchorKind.TESTID, value: 'new-id' });

    // A subsequent replay (the renamed anchor now resolves) is fully green.
    const steps = await replayFlow(session, loaded.value, waitForPredicate, FLOW_SIGNAL_TIMEOUT_MS);
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(steps.some((s) => s.drift !== undefined)).toBe(false);
  });

  it('heal apply:false returns the proposal but does NOT modify the file', async () => {
    await store.saveFlow(flowFile('chat', [clickStep('old-id')]));
    const before = await readFile(flowPath(root, 'chat'), 'utf8');
    const session = renamedSession('old-id', ['new-id']);

    const res = await heal(store, session, { flowName: 'chat', apply: false });
    expect(res.status).toBe(HealStatus.DRIFT);
    expect(res.applied).toBe(false);
    expect(res.changed).toEqual([]);
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]?.step).toBe(0);
    expect(res.proposals[0]?.from).toBe('old-id');
    expect(res.proposals[0]?.to).toBe('new-id');

    const after = await readFile(flowPath(root, 'chat'), 'utf8');
    expect(after).toEqual(before);
  });

  it('drift with no confident nearest leaves file untouched with a clear status', async () => {
    await store.saveFlow(flowFile('chat', [clickStep('old-id')]));
    const before = await readFile(flowPath(root, 'chat'), 'utf8');
    const session = renamedSession('old-id', ['zzz-unrelated']);

    const res = await heal(store, session, { flowName: 'chat', apply: true });
    expect(res.status).toBe(HealStatus.UNHEALABLE);
    expect(res.proposals).toEqual([]);
    expect(res.changed).toEqual([]);
    expect(res.applied).toBe(false);
    expect(res.message.length).toBeGreaterThan(0);

    const after = await readFile(flowPath(root, 'chat'), 'utf8');
    expect(after).toEqual(before);
  });

  it('heal on a green flow is a no-op "nothing to heal"', async () => {
    await store.saveFlow(flowFile('chat', [clickStep('chat-send')]));
    const before = await readFile(flowPath(root, 'chat'), 'utf8');
    const session = new FakeSession((testid) => ({ elements: [el(`e-${testid}`, testid)] }));

    const res = await heal(store, session, { flowName: 'chat', apply: true });
    expect(res.status).toBe(HealStatus.NOTHING_TO_HEAL);
    expect(res.changed).toEqual([]);
    expect(res.proposals).toEqual([]);
    expect(res.applied).toBe(false);

    const after = await readFile(flowPath(root, 'chat'), 'utf8');
    expect(after).toEqual(before);
  });

  it('heal on a missing flow returns a structured error', async () => {
    const session = new FakeSession(() => ({ elements: [] }));
    const res = await heal(store, session, { flowName: 'ghost', apply: true });
    expect(res.status).toBe(HealStatus.ERROR);
    expect(res.error?.code).toBe(FlowErrorCode.NOT_FOUND);
    expect(res.applied).toBe(false);
  });

  it('a path-traversal name is rejected before any disk op', async () => {
    const fsPort = createNodeFileSystem();
    const writeSpy = vi.spyOn(fsPort, 'writeFile');
    const readSpy = vi.spyOn(fsPort, 'readFile');
    const traverseStore = new FlowStore(fsPort, root, clock);
    const session = new FakeSession(() => ({ elements: [] }));

    const res = await heal(traverseStore, session, { flowName: '../etc/passwd', apply: true });
    expect(res.status).toBe(HealStatus.ERROR);
    expect(res.error?.code).toBe(FlowErrorCode.INVALID_NAME);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('apply rewrites only confident steps, leaves low-confidence steps', async () => {
    await store.saveFlow(flowFile('multi', [clickStep('old-id'), clickStep('save')]));
    // step0 'old-id' renamed to confident 'new-id'; step1 'save' has only a far 'delete-everything'.
    const session = new FakeSession((testid) => {
      if (testid === 'old-id')
        return { elements: [], hint: present(['new-id', 'delete-everything']) };
      if (testid === 'save')
        return { elements: [], hint: present(['new-id', 'delete-everything']) };
      return { elements: [el(`e-${testid}`, testid)] };
    });

    const res = await heal(store, session, { flowName: 'multi', apply: true });
    expect(res.status).toBe(HealStatus.HEALED);
    expect(res.changed).toEqual([{ step: 0, from: 'old-id', to: 'new-id' }]);

    const loaded = await store.load('multi');
    if (!loaded.ok) throw new Error('expected ok');
    expect(loaded.value.steps[0]?.anchor).toEqual({ kind: AnchorKind.TESTID, value: 'new-id' });
    expect(loaded.value.steps[1]?.anchor).toEqual({ kind: AnchorKind.TESTID, value: 'save' });
  });

  it('heal on a malformed flow file returns PARSE_FAILED, no write', async () => {
    const fsPort = createNodeFileSystem();
    const badStore = new FlowStore(fsPort, root, clock);
    // Materialize the flows dir + a garbage file.
    await store.saveFlow(flowFile('seed', [clickStep('x')]));
    await writeFile(flowPath(root, 'bad'), 'this is not json', 'utf8');
    const writeSpy = vi.spyOn(fsPort, 'writeFile');
    const session = new FakeSession(() => ({ elements: [] }));

    const res = await heal(badStore, session, { flowName: 'bad', apply: true });
    expect(res.status).toBe(HealStatus.ERROR);
    expect(res.error?.code).toBe(FlowErrorCode.PARSE_FAILED);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('heal apply:true then heal again is nothing_to_heal (idempotent)', async () => {
    await store.saveFlow(flowFile('chat', [clickStep('old-id')]));
    const first = await heal(store, renamedSession('old-id', ['new-id']), {
      flowName: 'chat',
      apply: true,
    });
    expect(first.status).toBe(HealStatus.HEALED);

    // The renamed anchor now resolves to a live element on a second pass.
    const greenSession = new FakeSession((testid) => ({ elements: [el(`e-${testid}`, testid)] }));
    const second = await heal(store, greenSession, { flowName: 'chat', apply: true });
    expect(second.status).toBe(HealStatus.NOTHING_TO_HEAL);
    expect(second.changed).toEqual([]);
  });

  it('healed file is re-readable, byte-stable, preserves createdAt + trailing newline', async () => {
    await store.saveFlow(flowFile('chat', [clickStep('old-id')]));
    await heal(store, renamedSession('old-id', ['new-id']), { flowName: 'chat', apply: true });

    const raw = await readFile(flowPath(root, 'chat'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.endsWith('\n\n')).toBe(false);
    const parsed = FlowFileSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.createdAt).toBe(FROZEN);
  });
});

/** Direct FlowStore.heal() unit checks (no tool/session indirection). */
describe('FlowStore.heal — writer', () => {
  let root: string;
  let store: FlowStore;
  let fsPort: FileSystemPort;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'iris-healw-'));
    root = join(dir, '.iris');
    fsPort = createNodeFileSystem();
    store = new FlowStore(fsPort, root, clock);
  });

  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  it('rewrites only the named step anchors, leaving every other step byte-identical', async () => {
    await store.saveFlow(
      flowFile('multi', [clickStep('keep-a'), clickStep('old-id'), clickStep('keep-b')]),
    );
    const before = await store.load('multi');
    if (!before.ok) throw new Error('expected ok');

    const res = await store.heal('multi', [{ step: 1, from: 'old-id', to: 'new-id' }]);
    expect(res.ok).toBe(true);

    const after = await store.load('multi');
    if (!after.ok) throw new Error('expected ok');
    expect(after.value.steps[0]?.anchor).toEqual(before.value.steps[0]?.anchor);
    expect(after.value.steps[2]?.anchor).toEqual(before.value.steps[2]?.anchor);
    expect(after.value.steps[1]?.anchor).toEqual({ kind: AnchorKind.TESTID, value: 'new-id' });
  });

  it('rejects a traversal name before any disk op', async () => {
    const writeSpy = vi.spyOn(fsPort, 'writeFile');
    const res = await store.heal('../escape', [{ step: 0, from: 'a', to: 'b' }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(FlowErrorCode.INVALID_NAME);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('returns NOT_FOUND for a missing flow', async () => {
    const res = await store.heal('ghost', [{ step: 0, from: 'a', to: 'b' }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(FlowErrorCode.NOT_FOUND);
  });
});
