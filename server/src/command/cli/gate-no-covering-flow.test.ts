/**
 * #2324: files changed, saved flows existed, and no saved flow covered the change. The gate exited 0
 * and logged `"pass": true`, while `reticle_verify change` answered `unknown` for the same change.
 * Nothing judged the change, so the gate now exits NOTHING_TO_CHECK and says why.
 */

import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
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
import { GateExit, MSG_GATE_NO_COVERING_FLOW, MSG_GATE_NO_FLOWS } from './answers/gate-exit.js';
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

describe('handleGate when no saved flow covers the changed files', () => {
  let dir: string;
  let root: string;
  let stderr: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-gate-no-cover-'));
    root = join(dir, ReticleDir.ROOT);
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    await mkdir(join(dir, 'src'), { recursive: true });
    // Not an interactive component, so `unflowed` stays empty and nothing else blocks the gate.
    await writeFile(
      join(dir, 'src', 'format.ts'),
      'export const format = (n: number) => `${n}`;\n',
    );
    await writeFile(join(dir, 'src', 'Other.vue'), '<button @click="go">go</button>\n');
    // Both files predate the passing run, so its result is current for them.
    for (const file of ['format.ts', 'Other.vue']) {
      await utimes(join(dir, 'src', file), 0.1, 0.1);
    }
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await removeTempDir(dir);
  });

  const saveFlow = async (name: string, source: string): Promise<void> => {
    const store = new FlowStore(createNodeFileSystem(), root, { now: () => 1 });
    await store.save({ name, version: 1, steps: [clickStep(name)] });
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

  it('does not pass, and says that no saved flow covers the change', async () => {
    await saveFlow('flow-a', 'src/Other.vue');
    await saveFlow('flow-b', 'src/Other.vue');
    await new RunStore(createNodeFileSystem(), root).write(passingRun(['flow-a', 'flow-b']));
    await handleGate(['src/format.ts'], undefined);
    expect(process.exitCode).toBe(GateExit.NOTHING_TO_CHECK);
    expect(gateJson()).toMatchObject({ pass: false, noCoveringFlow: ['src/format.ts'] });
    const out = stderr.join('');
    expect(out).toContain(MSG_GATE_NO_COVERING_FLOW);
    expect(out).not.toContain(MSG_GATE_NO_FLOWS);
  });

  it('does not block a Stop hook, which treats NOTHING_TO_CHECK as no regression', async () => {
    await saveFlow('flow-a', 'src/Other.vue');
    await new RunStore(createNodeFileSystem(), root).write(passingRun(['flow-a']));
    await handleGate(['src/format.ts'], undefined, true);
    expect(process.exitCode).toBe(GateExit.NOTHING_TO_CHECK);
    expect(stderr.join('')).not.toContain('this change is not verified');
  });

  it('still passes when a passing flow covers the changed file', async () => {
    await saveFlow('flow-a', 'src/Other.vue');
    await new RunStore(createNodeFileSystem(), root).write(passingRun(['flow-a']));
    await handleGate(['src/Other.vue'], undefined);
    expect(process.exitCode).toBeUndefined();
    const json = gateJson();
    expect(json).toMatchObject({ pass: true });
    expect(json).not.toHaveProperty('noCoveringFlow');
  });
});
