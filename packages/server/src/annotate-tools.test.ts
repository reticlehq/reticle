import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionType,
  AnnotationErrorCode,
  AnnotationKind,
  AnnotationTarget,
  QueryBy,
  type AnnotateResult,
} from '@iris/protocol';
import { TOOLS, type ToolDeps } from './tools.js';
import { IrisTool } from './tool-names.js';
import { BaselineStore } from './baselines.js';
import { RecordingStore, type RecordedStep } from './recordings.js';
import { AnnotationStore } from './annotation-store.js';
import { FlowStore } from './flows.js';
import { createNodeFileSystem, type FileSystemPort } from './fs-port.js';
import type { Session, SessionManager } from './session.js';

const clock = { now: (): number => 1234 };

function noopSession(): Partial<Session> {
  return {
    id: 'demo',
    command: () => Promise.resolve({ kind: 'command_result', id: 'a', ok: true, result: {} }),
    eventsSince: () => [],
    onEvent: () => () => undefined,
  };
}

function fakeDeps(
  fs: FileSystemPort,
  root: string,
  recordings: RecordingStore,
  annotations: AnnotationStore,
): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => noopSession() as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings,
    annotations,
    flows: new FlowStore(fs, root, clock),
    fs,
    irisRoot: root,
    now: clock.now,
  };
}

function tool(name: string): (typeof TOOLS)[number] {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

function actStep(value: string): RecordedStep {
  return {
    tool: IrisTool.ACT,
    stable: true,
    args: { by: QueryBy.TESTID, value, action: ActionType.CLICK, args: {} },
  };
}

/** Start a recording named `name` with `n` captured steps already in the buffer. */
function recordingWith(name: string, n: number): RecordingStore {
  const recordings = new RecordingStore();
  recordings.start(name, 0);
  for (let i = 0; i < n; i++) recordings.capture(actStep(`step-${String(i)}`));
  return recordings;
}

describe('iris_annotate handler (M8 Stage B ANNOTATE) — temp dir, never touches the repo', () => {
  let dir: string;
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'iris-annotate-'));
    root = join(dir, '.iris');
    fs = createNodeFileSystem();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('C1: annotate during an active recording sets the last step expect + returns compiled text', async () => {
    const recordings = recordingWith('default', 2);
    const annotations = new AnnotationStore();
    const deps = fakeDeps(fs, root, recordings, annotations);

    const res = (await tool(IrisTool.ANNOTATE).handler(deps, {
      kind: AnnotationKind.ASSERT_SIGNAL,
      name: 'diff:shown',
    })) as AnnotateResult;
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.target).toBe(AnnotationTarget.STEP);
    expect(res.compiled).toBe('will assert signal diff:shown');
    expect(annotations.stepExpect('default').get(1)?.signal).toBe('diff:shown');
  });

  it('C2: annotate mark-dynamic adds to the flow dynamic list', async () => {
    const recordings = recordingWith('default', 2);
    const annotations = new AnnotationStore();
    const deps = fakeDeps(fs, root, recordings, annotations);

    await tool(IrisTool.ANNOTATE).handler(deps, {
      kind: AnnotationKind.MARK_DYNAMIC,
      testid: 'caption-text',
    });
    expect(annotations.dynamic('default')).toContain('caption-text');
  });

  it('C3: annotate success-state sets the flow success', async () => {
    const recordings = recordingWith('default', 1);
    const annotations = new AnnotationStore();
    const deps = fakeDeps(fs, root, recordings, annotations);

    await tool(IrisTool.ANNOTATE).handler(deps, {
      kind: AnnotationKind.SUCCESS_STATE,
      signal: 'diff:shown',
    });
    expect(annotations.success('default')?.signal).toBe('diff:shown');
  });

  it('C4: annotate with NO active recording returns NO_ACTIVE_RECORDING (no throw)', async () => {
    const recordings = new RecordingStore(); // never started
    const annotations = new AnnotationStore();
    const deps = fakeDeps(fs, root, recordings, annotations);

    const res = (await tool(IrisTool.ANNOTATE).handler(deps, {
      kind: AnnotationKind.MARK_DYNAMIC,
      testid: 'x',
    })) as AnnotateResult;
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected not ok');
    expect(res.code).toBe(AnnotationErrorCode.NO_ACTIVE_RECORDING);
  });

  it('C5: assert-signal annotate before any step returns NO_STEP_TO_ANNOTATE', async () => {
    const recordings = recordingWith('default', 0);
    const annotations = new AnnotationStore();
    const deps = fakeDeps(fs, root, recordings, annotations);

    const res = (await tool(IrisTool.ANNOTATE).handler(deps, {
      kind: AnnotationKind.ASSERT_SIGNAL,
      name: 'x',
    })) as AnnotateResult;
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected not ok');
    expect(res.code).toBe(AnnotationErrorCode.NO_STEP_TO_ANNOTATE);
  });

  it('C6: an unknown kind returns UNKNOWN_KIND (rejected, store untouched)', async () => {
    const recordings = recordingWith('default', 1);
    const annotations = new AnnotationStore();
    const deps = fakeDeps(fs, root, recordings, annotations);

    const res = (await tool(IrisTool.ANNOTATE).handler(deps, {
      kind: 'frobnicate',
    })) as AnnotateResult;
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected not ok');
    expect(res.code).toBe(AnnotationErrorCode.UNKNOWN_KIND);
    expect(annotations.dynamic('default')).toEqual([]);
    expect(annotations.success('default')).toBeUndefined();
  });

  it('C7: annotate then iris_flow_save persists expect+dynamic+success into the FlowFile', async () => {
    const recordings = recordingWith('checkout', 2);
    // Mirror the agent recording into a compiled program the save tool reads.
    recordings.saveCompiled({
      name: 'checkout',
      version: 1,
      steps: [actStep('a'), actStep('b')],
    });
    const annotations = new AnnotationStore();
    const deps = fakeDeps(fs, root, recordings, annotations);

    await tool(IrisTool.ANNOTATE).handler(deps, {
      flow: 'checkout',
      kind: AnnotationKind.ASSERT_SIGNAL,
      name: 'diff:shown',
    });
    await tool(IrisTool.ANNOTATE).handler(deps, {
      flow: 'checkout',
      kind: AnnotationKind.MARK_DYNAMIC,
      testid: 'caption-text',
    });
    await tool(IrisTool.ANNOTATE).handler(deps, {
      flow: 'checkout',
      kind: AnnotationKind.SUCCESS_STATE,
      signal: 'diff:shown',
    });
    await tool(IrisTool.FLOW_SAVE).handler(deps, { name: 'checkout' });

    const loaded = (await tool(IrisTool.FLOW_LOAD).handler(deps, { name: 'checkout' })) as {
      steps: { expect?: { signal?: string } }[];
      dynamic?: { kind: string; value?: string }[];
      success?: { signal?: string };
    };
    expect(loaded.steps[1]?.expect?.signal).toBe('diff:shown');
    expect(loaded.dynamic?.some((d) => d.value === 'caption-text')).toBe(true);
    expect(loaded.success?.signal).toBe('diff:shown');
  });

  it('C8: assert-signal with dataMatches round-trips through save then load', async () => {
    const recordings = recordingWith('dm', 1);
    recordings.saveCompiled({ name: 'dm', version: 1, steps: [actStep('a')] });
    const annotations = new AnnotationStore();
    const deps = fakeDeps(fs, root, recordings, annotations);

    await tool(IrisTool.ANNOTATE).handler(deps, {
      flow: 'dm',
      kind: AnnotationKind.ASSERT_SIGNAL,
      name: 'diff:shown',
      dataMatches: { count: 2 },
    });
    await tool(IrisTool.FLOW_SAVE).handler(deps, { name: 'dm' });

    const loaded = (await tool(IrisTool.FLOW_LOAD).handler(deps, { name: 'dm' })) as {
      steps: { expect?: { signalData?: Record<string, unknown> } }[];
    };
    expect(loaded.steps[0]?.expect?.signalData).toEqual({ count: 2 });
  });
});
