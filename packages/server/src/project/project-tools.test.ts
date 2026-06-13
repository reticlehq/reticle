import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectReadError, RunKind, RunStatus } from '@syrin/iris-protocol';
import { TOOLS, type ToolDeps } from '../tools/tools.js';
import { IrisTool } from '../tools/tool-names.js';
import { BaselineStore } from './baselines.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from './project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import { createNodeFileSystem, type FileSystemPort } from './fs-port.js';
import type { Session, SessionManager } from '../session/session.js';

const clock = { now: (): number => 1234 };

function noopSession(): Partial<Session> {
  return {
    id: 'demo',
    command: () => Promise.resolve({ kind: 'command_result', id: 'a', ok: true, result: {} }),
    eventsSince: () => [],
    onEvent: () => () => undefined,
  };
}

function fakeDeps(fs: FileSystemPort, root: string): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => noopSession() as Session };
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
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

describe('project tools — temp dir, never touches the repo', () => {
  let dir: string;
  let root: string;
  let fs: FileSystemPort;
  let deps: ToolDeps;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'iris-proj-tools-'));
    root = join(dir, '.iris');
    fs = createNodeFileSystem();
    deps = fakeDeps(fs, root);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('1: iris_run_record appends a run, defaulting kind to manual', async () => {
    const res = (await tool(IrisTool.RUN_RECORD).handler(deps, {
      name: 'checkout',
      status: RunStatus.PASS,
    })) as { recorded: boolean; name: string };
    expect(res.recorded).toBe(true);
    const last = await deps.project.lastRun('checkout');
    expect(last?.kind).toBe(RunKind.MANUAL);
    expect(last?.status).toBe(RunStatus.PASS);
    expect(last?.at).toBe(1234);
  });

  it('2: iris_project on empty history returns a structured MISSING error', async () => {
    const res = (await tool(IrisTool.PROJECT).handler(deps, {})) as { reason?: string };
    expect(res.reason).toBe(ProjectReadError.MISSING);
  });

  it('3: iris_project (no name) returns the full run list', async () => {
    await deps.project.recordRun({ kind: RunKind.MANUAL, name: 'a', status: RunStatus.PASS });
    await deps.project.recordRun({ kind: RunKind.MANUAL, name: 'b', status: RunStatus.FAIL });
    const res = (await tool(IrisTool.PROJECT).handler(deps, {})) as {
      runs: { name: string }[];
    };
    expect(res.runs.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('4: iris_project { name } returns scoped runs + lastRun + diff-vs-last', async () => {
    await deps.project.recordRun({
      kind: RunKind.FLOW_REPLAY,
      name: 'checkout',
      status: RunStatus.PASS,
      evidence: { driftSteps: 0, consoleErrors: 0 },
    });
    await deps.project.recordRun({
      kind: RunKind.FLOW_REPLAY,
      name: 'checkout',
      status: RunStatus.DRIFT,
      evidence: { driftSteps: 2, consoleErrors: 3 },
    });
    const res = (await tool(IrisTool.PROJECT).handler(deps, { name: 'checkout' })) as {
      runs: unknown[];
      lastRun?: { status: string };
      diff?: {
        statusChanged: boolean;
        regressed: boolean;
        consoleErrorsDelta?: number;
        driftStepsDelta?: number;
      };
    };
    expect(res.runs).toHaveLength(2);
    expect(res.lastRun?.status).toBe(RunStatus.DRIFT);
    expect(res.diff?.statusChanged).toBe(true);
    expect(res.diff?.regressed).toBe(true);
    expect(res.diff?.consoleErrorsDelta).toBe(3);
    expect(res.diff?.driftStepsDelta).toBe(2);
  });

  it('5: iris_project { name } with a single run has lastRun but no diff', async () => {
    await deps.project.recordRun({ kind: RunKind.MANUAL, name: 'solo', status: RunStatus.PASS });
    const res = (await tool(IrisTool.PROJECT).handler(deps, { name: 'solo' })) as {
      lastRun?: unknown;
      diff?: unknown;
    };
    expect(res.lastRun).toBeDefined();
    expect(res.diff).toBeUndefined();
  });
});
