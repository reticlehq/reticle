/**
 * Saving what the agent recorded: the route it started on, the name it is saved as, and an error
 * that names what exists.
 *
 * `reticle_flow_save` always read the agent's compiled recording — and `flowName` there used to mean
 * the RECORDING's name, while every other flow tool reads it as the name to save AS. Recording
 * `default` and saving as `sign-in` therefore looked obviously right and answered "no compiled
 * recording by that name", and a flow could only ever be called whatever the recording was started
 * as. `flowName` is now the name to save as, and `recording` picks which recording to fold.
 */
import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionType, FlowErrorCode, QueryBy } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore, type CompiledProgram } from './recordings.js';
import { AnnotationStore } from './annotation-store.js';
import { FlowStore } from './flows.js';
import { ProjectStore } from '../project/project-store.js';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import type { Session } from '../session/session.js';

const clock = { now: (): number => 1234 };
let root: string;
let fs: FileSystemPort;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reticle-save-'));
  fs = createNodeFileSystem();
});
afterEach(async () => removeTempDir(root));

const deps = (recordings: RecordingStore): ToolDeps =>
  ({
    sessions: {
      resolve: () =>
        ({
          id: 'demo',
          eventsSince: () => [],
          onEvent: () => () => undefined,
        }) as unknown as Session,
    },
    baselines: new BaselineStore(),
    recordings,
    annotations: new AnnotationStore(),
    flows: new FlowStore(fs, root, clock),
    project: new ProjectStore(fs, root, clock),
    fs,
    reticleRoot: root,
    now: clock.now,
  }) as ToolDeps;

const save = TOOLS.find((t) => t.name === ReticleTool.FLOW_SAVE);

const stored = (over: Partial<CompiledProgram> = {}): RecordingStore => {
  const store = new RecordingStore();
  store.saveCompiled({
    name: 'triage',
    version: 1,
    steps: [
      {
        tool: ReticleTool.ACT,
        stable: true,
        args: { by: QueryBy.TESTID, value: 'nav-issues', action: ActionType.CLICK, args: {} },
      },
    ],
    ...over,
  });
  return store;
};

const readSaved = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(root, 'flows', 'triage.json'), 'utf8')) as Record<string, unknown>;

describe('the route a recorded journey began on', () => {
  it('is written to the flow, so replay is not left wherever the tab happens to be', async () => {
    await save?.handler(deps(stored({ startPath: '/' })), { flowName: 'triage' });
    expect((await readSaved()).startPath).toBe('/');
  });

  it('is absent when the recording never captured one — never invented', async () => {
    await save?.handler(deps(stored()), { flowName: 'triage' });
    expect((await readSaved()).startPath).toBeUndefined();
  });
});

describe('asking for a recording that is not there', () => {
  it('falls back to the plain message when there is genuinely nothing to save', async () => {
    const res = (await save?.handler(deps(new RecordingStore()), { flowName: 'sign-in' })) as {
      error?: string;
    };
    expect(res.error).toContain('record one');
  });
});

/**
 * `flowName` is the name to save AS — the meaning every other flow tool gives it. The recording to
 * fold is `recording`, and it defaults to the obvious one: a recording made under `flowName`, or the
 * only one held. A file that can only ever carry the name the recording was started with had to be
 * renamed on disk to be called anything else.
 */
const withSteps = (store: RecordingStore, name: string, testid: string): RecordingStore => {
  store.saveCompiled({
    name,
    version: 1,
    steps: [
      {
        tool: ReticleTool.ACT,
        stable: true,
        args: { by: QueryBy.TESTID, value: testid, action: ActionType.CLICK, args: {} },
      },
    ],
  });
  return store;
};

const readFlow = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(root, 'flows', `${name}.json`), 'utf8')) as Record<
    string,
    unknown
  >;

describe('the name a recording is saved as', () => {
  it('saves the only held recording under flowName when the two names differ', async () => {
    const res = (await save?.handler(deps(stored({ name: 'default' })), {
      flowName: 'sign-in',
    })) as { name?: string; error?: string };
    expect(res.error).toBeUndefined();
    expect(res.name).toBe('sign-in');
    expect((await readFlow('sign-in'))['name']).toBe('sign-in');
  });

  it('folds the recording named by `recording` and saves it as flowName', async () => {
    const store = withSteps(withSteps(new RecordingStore(), 'first', 'nav-a'), 'second', 'nav-b');
    const res = (await save?.handler(deps(store), {
      recording: 'second',
      flowName: 'sign-in',
    })) as { name?: string; error?: string };
    expect(res.error).toBeUndefined();
    expect(res.name).toBe('sign-in');
    const steps = (await readFlow('sign-in'))['steps'] as { anchor: { value?: string } }[];
    expect(steps[0]?.anchor.value).toBe('nav-b');
  });

  it('still reads flowName as the recording name when a recording was made under it', async () => {
    const store = withSteps(withSteps(new RecordingStore(), 'triage', 'nav-a'), 'other', 'nav-b');
    const res = (await save?.handler(deps(store), { flowName: 'triage' })) as {
      name?: string;
      error?: string;
    };
    expect(res.error).toBeUndefined();
    expect(res.name).toBe('triage');
    const steps = (await readFlow('triage'))['steps'] as { anchor: { value?: string } }[];
    expect(steps[0]?.anchor.value).toBe('nav-a');
  });

  it('refuses to guess between several recordings, and says how to choose', async () => {
    const store = withSteps(withSteps(new RecordingStore(), 'first', 'nav-a'), 'second', 'nav-b');
    const res = (await save?.handler(deps(store), { flowName: 'sign-in' })) as {
      error?: string;
      code?: string;
    };
    expect(res.code).toBe(FlowErrorCode.NO_RECORDING);
    expect(res.error).toContain("'first'");
    expect(res.error).toContain("'second'");
    expect(res.error).toContain('recording: "');
  });

  it('names an unknown `recording` and what is held instead', async () => {
    const res = (await save?.handler(deps(stored({ name: 'triage' })), {
      recording: 'nope',
      flowName: 'sign-in',
    })) as { error?: string; code?: string };
    expect(res.code).toBe(FlowErrorCode.NO_RECORDING);
    expect(res.error).toContain("'nope'");
    expect(res.error).toContain("'triage'");
  });
});
