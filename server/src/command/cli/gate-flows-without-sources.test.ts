/**
 * On a stack without source stamping (Vue, for one) no saved flow records a source location, so no flow can
 * be matched to a changed file and every changed component lands in `unflowed`. The gate then told
 * the human "no saved flow drives it" about a component a flow had just driven and passed. The fix
 * is in what the gate says, not in what it decides: it names the missing source locations instead.
 */

import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActionType,
  QueryBy,
  ReticleDir,
  RunAgentKind,
  RunFlowStatus,
  RunFramework,
  RunProfile,
  RunTrigger,
} from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { FlowStore } from '@/language/flows/flows.js';
import { RunStore } from '@/judgement/runs/artifact/run-store.js';
import { buildVerificationRun } from '@/judgement/runs/artifact/build-verification-run.js';
import { handleGate } from './cli-flow-commands.js';

const clickStep = (testid: string) => ({
  tool: 'reticle_act',
  stable: true,
  args: { by: QueryBy.TESTID, value: testid, action: ActionType.CLICK, args: {} },
});

const passingRun = (flows: readonly string[]) =>
  buildVerificationRun(
    {
      runId: 'replay',
      durationMs: 100,
      profile: RunProfile.DEV,
      project: { name: 'demo', framework: RunFramework.VITE },
      agent: { id: 'a', kind: RunAgentKind.CODING_AGENT },
      trigger: { kind: RunTrigger.EDIT },
      changedFiles: [],
      flows: flows.map((name) => ({ name, status: RunFlowStatus.PASS, steps: 1, durationMs: 1 })),
      checks: [],
      risks: [],
      evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
    },
    () => 5000,
  );

describe('handleGate when the saved flows carry no sources', () => {
  let dir: string;
  let root: string;
  let stderr: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-gate-sources-'));
    root = join(dir, ReticleDir.ROOT);
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'Badge.vue'), '<button @click="go">go</button>\n');
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await removeTempDir(dir);
  });

  // Saved as a recorder saves it; a `source` is then stamped onto its steps the way a build with
  // source stamping would have recorded it.
  const saveFlow = async (name: string, source?: string): Promise<void> => {
    const store = new FlowStore(createNodeFileSystem(), root, { now: () => 1 });
    await store.save({ name, version: 1, steps: [clickStep(name)] });
    if (source === undefined) {
      return;
    }
    const loaded = await store.load(name);
    if (!loaded.ok) {
      throw new Error(`${name} did not load`);
    }
    await store.saveFlow({
      ...loaded.value,
      steps: loaded.value.steps.map((step) => ({ ...step, source: { file: source } })),
    });
  };

  const gateJson = (): Record<string, unknown> => {
    const line = stderr.map((s) => s.trim()).find((s) => s.includes('"event":"reticle_gate"'));
    expect(line).toBeDefined();
    return JSON.parse(line ?? '{}') as Record<string, unknown>;
  };

  it('says the flows carry no source locations instead of claiming nothing drove the file', async () => {
    await saveFlow('flow-a');
    await saveFlow('flow-b');
    await new RunStore(createNodeFileSystem(), root).write(passingRun(['flow-a', 'flow-b']));
    await handleGate(['src/Badge.vue'], undefined, true);
    const out = stderr.join('');
    expect(gateJson()).toMatchObject({ unflowed: ['src/Badge.vue'], flowsWithoutSources: true });
    expect(out).toContain('carry no source locations');
    expect(out).toContain('src/Badge.vue');
    expect(out).not.toContain('no saved flow drives it');
  });

  it('keeps "no saved flow drives it" when a flow does record sources, just not this file', async () => {
    await saveFlow('flow-a', 'src/Other.vue');
    await saveFlow('flow-b');
    await new RunStore(createNodeFileSystem(), root).write(passingRun(['flow-a', 'flow-b']));
    await handleGate(['src/Badge.vue'], undefined, true);
    const out = stderr.join('');
    const json = gateJson();
    expect(json).toMatchObject({ unflowed: ['src/Badge.vue'] });
    expect(json).not.toHaveProperty('flowsWithoutSources');
    expect(out).toContain('no saved flow drives it');
    expect(out).not.toContain('carry no source locations');
  });
});
