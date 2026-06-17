import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionType,
  DANGEROUS_ACTION_CONFIRM_ARG,
  FlowErrorCode,
  IrisCommand,
  QueryBy,
  ReplayStatus,
  RunKind,
  RunStatus,
  type CommandResult,
  type FlowReplayResult,
} from '@syrin/iris-protocol';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { IrisTool } from '../tools/tool-names.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore } from './recordings.js';
import { FlowStore } from './flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from './annotation-store.js';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import { flowPath } from '../project/iris-dir.js';
import { asRecord, asString } from '../tools/tools-helpers.js';
import type { Session, SessionManager } from '../session/session.js';
import type { CompiledProgram, RecordedStep } from './recordings.js';

const clock = { now: (): number => 1234 };

interface ScriptedSessionOptions {
  actOk?: boolean;
  actArgs?: Record<string, unknown>[];
}

/** A session whose QUERY answers from a per-testid script and whose ACT is configurable. */
function scriptedSession(
  queryScript: (testid: string) => unknown,
  options: ScriptedSessionOptions = {},
): Partial<Session> {
  const command = (name: string, args: Record<string, unknown> = {}): Promise<CommandResult> => {
    if (name === IrisCommand.QUERY) {
      return Promise.resolve({
        kind: 'command_result',
        id: 'q',
        ok: true,
        result: queryScript(asString(args['value']) ?? ''),
      });
    }
    if (name === IrisCommand.ACT) {
      options.actArgs?.push(asRecord(args['args']));
      const ok = options.actOk ?? true;
      return Promise.resolve({
        kind: 'command_result',
        id: 'a',
        ok,
        result: {},
        ...(ok ? {} : { error: 'act failed' }),
      });
    }
    return Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result: {} });
  };
  return { id: 'demo', command, eventsSince: () => [], onEvent: () => () => undefined };
}

function fakeDeps(
  fs: FileSystemPort,
  root: string,
  session: Partial<Session>,
  recordings = new RecordingStore(),
): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings,
    flows: new FlowStore(fs, root, clock),
    project: new ProjectStore(fs, root, clock),
    annotations: new AnnotationStore(),
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

function program(name: string, steps: RecordedStep[]): CompiledProgram {
  return { name, version: 1, steps };
}

function actStep(value: string): RecordedStep {
  return {
    tool: IrisTool.ACT,
    stable: true,
    args: { by: QueryBy.TESTID, value, action: ActionType.CLICK, args: {} },
  };
}

describe('iris_flow_replay handler — temp dir, never touches the repo', () => {
  let dir: string;
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'iris-replay-'));
    root = join(dir, '.iris');
    fs = createNodeFileSystem();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function saveFlow(name: string, steps: RecordedStep[]): Promise<void> {
    const store = new FlowStore(fs, root, clock);
    const res = await store.save(program(name, steps));
    if (!res.ok) throw new Error(`save failed: ${res.code}`);
  }

  it('A: a flow whose testids all resolve replays with status ok', async () => {
    await saveFlow('green', [actStep('chat-send'), actStep('chat-input')]);
    const session = scriptedSession((testid) => ({ elements: [{ ref: `e-${testid}` }] }));
    const deps = fakeDeps(fs, root, session);

    const res = (await tool(IrisTool.FLOW_REPLAY).handler(deps, {
      flowName: 'green',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.OK);
    expect(res.name).toBe('green');
    expect(res.steps).toHaveLength(2);
    expect(res.steps.every((s) => s.ok)).toBe(true);
  });

  it('B: a flow with one renamed testid returns status drift with a computed nearest', async () => {
    await saveFlow('renamed', [actStep('chat-send')]);
    const session = scriptedSession(() => ({
      elements: [],
      hint: {
        route: '/',
        presentTestids: ['chat-submit', 'sidebar-toggle'],
        knownEmptyState: false,
      },
    }));
    const deps = fakeDeps(fs, root, session);

    const res = (await tool(IrisTool.FLOW_REPLAY).handler(deps, {
      flowName: 'renamed',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.DRIFT);
    expect(res.steps.at(-1)?.drift?.nearest).toBe('chat-submit');
    expect(res.steps.at(-1)?.drift?.reason).toBe('testid "chat-send" not found');
  });

  it('C: a missing flow file returns a structured error envelope (no throw)', async () => {
    const session = scriptedSession(() => ({ elements: [] }));
    const deps = fakeDeps(fs, root, session);

    const res = (await tool(IrisTool.FLOW_REPLAY).handler(deps, {
      flowName: 'nope',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.ERROR);
    expect(res.error?.code).toBe(FlowErrorCode.NOT_FOUND);
    expect(res.steps).toHaveLength(0);
  });

  it('D: a corrupt flow file returns status error with a parse-failed code', async () => {
    await fs.mkdir(join(root, 'flows'));
    await fs.writeFile(flowPath(root, 'bad'), '{ not: a flow');
    const session = scriptedSession(() => ({ elements: [] }));
    const deps = fakeDeps(fs, root, session);

    const res = (await tool(IrisTool.FLOW_REPLAY).handler(deps, {
      flowName: 'bad',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.ERROR);
    expect(res.error?.code).toBe(FlowErrorCode.PARSE_FAILED);
    expect(res.steps).toHaveLength(0);
  });

  it('E: an invalid flow name returns a structured error (no path escape)', async () => {
    const session = scriptedSession(() => ({ elements: [] }));
    const deps = fakeDeps(fs, root, session);

    const res = (await tool(IrisTool.FLOW_REPLAY).handler(deps, {
      flowName: '../escape',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.ERROR);
    expect(res.error?.code).toBe(FlowErrorCode.INVALID_NAME);
  });

  // ---- every replay records a run to .iris/project.json ----

  it('F: an ok replay auto-records a pass run with mapped status + driftSteps:0', async () => {
    await saveFlow('green', [actStep('chat-send')]);
    const session = scriptedSession((testid) => ({ elements: [{ ref: `e-${testid}` }] }));
    const deps = fakeDeps(fs, root, session);

    await tool(IrisTool.FLOW_REPLAY).handler(deps, { flowName: 'green' });
    const history = await deps.project.read();
    expect(history.ok).toBe(true);
    if (!history.ok) throw new Error('expected history');
    expect(history.file.runs).toHaveLength(1);
    expect(history.file.runs[0]).toMatchObject({
      kind: RunKind.FLOW_REPLAY,
      name: 'green',
      status: RunStatus.PASS,
      evidence: { driftSteps: 0 },
    });
  });

  it('G: the missing-flow ERROR early-return also records an error run', async () => {
    const session = scriptedSession(() => ({ elements: [] }));
    const deps = fakeDeps(fs, root, session);

    await tool(IrisTool.FLOW_REPLAY).handler(deps, { flowName: 'nope' });
    const last = await deps.project.lastRun('nope');
    expect(last?.status).toBe(RunStatus.ERROR);
    expect(last?.kind).toBe(RunKind.FLOW_REPLAY);
  });

  it('H: an action failure is an error, not selector drift', async () => {
    await saveFlow('action-fails', [actStep('chat-send')]);
    const session = scriptedSession((testid) => ({ elements: [{ ref: `e-${testid}` }] }), {
      actOk: false,
    });
    const deps = fakeDeps(fs, root, session);

    const res = (await tool(IrisTool.FLOW_REPLAY).handler(deps, {
      flowName: 'action-fails',
    })) as FlowReplayResult;
    expect(res.status).toBe(ReplayStatus.ERROR);
    expect(res.steps[0]).toMatchObject({ ok: false, error: 'act failed' });
    expect(res.error).toEqual({ code: ReplayStatus.ERROR, message: 'act failed' });

    const last = await deps.project.lastRun('action-fails');
    expect(last?.status).toBe(RunStatus.ERROR);
    expect(last?.evidence).toMatchObject({ driftSteps: 0 });
  });

  it('I: destructive-action confirmation is scoped to the current replay invocation', async () => {
    await saveFlow('dangerous', [actStep('delete-account')]);
    const actArgs: Record<string, unknown>[] = [];
    const session = scriptedSession((testid) => ({ elements: [{ ref: `e-${testid}` }] }), {
      actArgs,
    });
    const deps = fakeDeps(fs, root, session);

    await tool(IrisTool.FLOW_REPLAY).handler(deps, { flowName: 'dangerous' });
    await tool(IrisTool.FLOW_REPLAY).handler(deps, {
      flowName: 'dangerous',
      confirmDangerous: true,
    });

    expect(actArgs[0]).not.toHaveProperty(DANGEROUS_ACTION_CONFIRM_ARG);
    expect(actArgs[1]).toMatchObject({ [DANGEROUS_ACTION_CONFIRM_ARG]: true });
  });
});
