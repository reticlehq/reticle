import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RunAgentKind,
  RunCheckKind,
  RunCheckStatus,
  RunFramework,
  RunProfile,
  RunTrigger,
} from '@reticlehq/protocol';
import { ReticleTool } from '../tools/tool-names.js';
import type { ToolDeps } from '../tools/tools.js';
import type { SessionManager } from '../session/session.js';
import { BaselineStore } from '../project/baselines.js';
import { RecordingStore } from '../flows/recordings.js';
import { FlowStore } from '../flows/flows.js';
import { ProjectStore } from '../project/project-store.js';
import { AnnotationStore } from '../flows/annotation-store.js';
import { createNodeFileSystem } from '../project/fs-port.js';
import { RUN_TOOLS } from './run-tools.js';
import { RunStore } from './run-store.js';
import { buildVerificationRun, type VerificationRunInput } from './build-verification-run.js';

const now = (): number => 0;

function depsFor(root: string): ToolDeps {
  const fs = createNodeFileSystem();
  const sessions: Partial<SessionManager> = {};
  return {
    sessions: sessions as SessionManager,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    flows: new FlowStore(fs, root, { now }),
    project: new ProjectStore(fs, root, { now }),
    annotations: new AnnotationStore(),
    fs,
    reticleRoot: root,
    now,
  };
}

const failingRun = (runId: string): VerificationRunInput => ({
  runId,
  durationMs: 10,
  profile: RunProfile.DEV,
  project: { name: 'demo', framework: RunFramework.REACT },
  agent: { id: 'ci', kind: RunAgentKind.OEM_PIPELINE },
  trigger: { kind: RunTrigger.CI },
  changedFiles: [],
  flows: [],
  checks: [
    { kind: RunCheckKind.NETWORK, predicate: 'POST /api/order 200', status: RunCheckStatus.FAIL },
  ],
  risks: [],
  evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
});

const tool = RUN_TOOLS.find((t) => t.name === ReticleTool.RUN_EXPORT);

describe('reticle_run_export (MCP persona)', () => {
  let root: string;
  let deps: ToolDeps;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-runtools-'));
    root = join(dir, '.reticle');
    deps = depsFor(root);
    await new RunStore(deps.fs, root).write(buildVerificationRun(failingRun('run-a'), () => 1000));
  });

  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  it('is registered', () => {
    expect(tool).toBeDefined();
  });

  it('returns the latest run as JSON by default', async () => {
    if (tool === undefined) return;
    const out = (await tool.handler(deps, {})) as { run?: { runId: string } };
    expect(out.run?.runId).toBe('run-a');
  });

  it('returns a specific run by id', async () => {
    if (tool === undefined) return;
    const out = (await tool.handler(deps, { runId: 'run-a' })) as { run?: { runId: string } };
    expect(out.run?.runId).toBe('run-a');
  });

  it('returns a legible text report with format:"report"', async () => {
    if (tool === undefined) return;
    const out = (await tool.handler(deps, { format: 'report' })) as { report?: string };
    expect(out.report).toContain('Reticle verification — demo');
    expect(out.report).toContain('✗ FAIL');
  });

  it('returns an error for an unknown runId', async () => {
    if (tool === undefined) return;
    const out = (await tool.handler(deps, { runId: 'nope' })) as { error?: string };
    expect(out.error).toContain("no run 'nope'");
  });
});
