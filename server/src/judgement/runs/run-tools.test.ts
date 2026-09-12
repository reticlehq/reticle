import { removeTempDir } from '../../machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RunAgentKind,
  PredicateKind,
  Verified,
  RunFramework,
  RunProfile,
  RunTrigger,
} from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import type { ToolDeps } from '../../surface/tools/tools.js';
import type { SessionManager } from '../../portal/session/session.js';
import { BaselineStore } from '../../memory/project/baselines.js';
import { RecordingStore } from '../../features/flows/recording/tape/recordings.js';
import { FlowStore } from '../../features/flows/flows.js';
import { ProjectStore } from '../../memory/project/project-store.js';
import { AnnotationStore } from '../../features/flows/stores/annotation-store.js';
import { createNodeFileSystem } from '../../memory/project/fs/fs-port.js';
import { RUN_TOOLS } from './run-tools.js';
import { RunStore } from './artifact/run-store.js';
import {
  buildVerificationRun,
  type VerificationRunInput,
} from './artifact/build-verification-run.js';

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
  checks: [{ kind: PredicateKind.NET, predicate: 'POST /api/order 200', status: Verified.NO }],
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
    await removeTempDir(join(root, '..'));
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

  it('returns the OpenReality artifact with format:"openreality"', async () => {
    if (tool === undefined) return;
    const out = (await tool.handler(deps, { format: 'openreality' })) as {
      artifact?: { kind?: string; runId?: string; subject?: { name?: string } };
    };
    // The protocol shape, not Reticle's own run shape: a consumer who implements OVP and has never
    // seen this codebase reads `kind` to know what it is holding.
    expect(out.artifact?.kind).toBe('openreality.verification');
    expect(out.artifact?.runId).toBe('run-a');
    expect(out.artifact?.subject?.name).toBe('demo');
  });

  it('exports the same artifact twice, so a consumer can diff two exports meaningfully', async () => {
    if (tool === undefined) return;
    // `toArtifact` is pure by design -- it reads no clock, precisely so that exporting one run
    // twice cannot produce two different documents. Wiring it to a tool is the step that could
    // break that, by stamping a time on the way out.
    const a = (await tool.handler(deps, { format: 'openreality' })) as Record<string, unknown>;
    const b = (await tool.handler(deps, { format: 'openreality' })) as Record<string, unknown>;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
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

  it('format:"diff" errors when fewer than two runs exist', async () => {
    if (tool === undefined) return;
    const out = (await tool.handler(deps, { format: 'diff' })) as { error?: string };
    expect(out.error).toContain('at least two');
  });

  it('format:"diff" returns the run-to-run delta once a second run exists', async () => {
    if (tool === undefined) return;
    // A later run so latestTwo sees [run-a, run-b] oldest-first.
    await new RunStore(deps.fs, root).write(buildVerificationRun(failingRun('run-b'), () => 2000));
    const out = (await tool.handler(deps, { format: 'diff' })) as {
      diff?: { headline?: string };
    };
    expect(typeof out.diff?.headline).toBe('string');
  });
});
