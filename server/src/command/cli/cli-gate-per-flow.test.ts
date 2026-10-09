import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  ActionType,
  QueryBy,
  ReticleDir,
  RunAgentKind,
  RunFlowStatus,
  RunFramework,
  RunProfile,
  RunTrigger,
  type RunFlowResult,
} from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { FlowStore } from '@/language/flows/flows.js';
import { RunStore } from '@/judgement/runs/artifact/run-store.js';
import { buildVerificationRun } from '@/judgement/runs/artifact/build-verification-run.js';
import { emitBuddyStatus, handleGate } from './cli-flow-commands.js';

const flowResult = (name: string, status: RunFlowStatus): RunFlowResult => ({
  name,
  status,
  steps: 1,
  durationMs: 1,
});

const runAt = (runId: string, at: number, flows: RunFlowResult[]) =>
  buildVerificationRun(
    {
      runId,
      durationMs: 100,
      profile: RunProfile.DEV,
      project: { name: 'demo', framework: RunFramework.REACT },
      agent: { id: 'a', kind: RunAgentKind.CODING_AGENT },
      trigger: { kind: RunTrigger.EDIT },
      changedFiles: [],
      flows,
      checks: [],
      risks: [],
      evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
    },
    () => at,
  );

describe('handleGate reads coverage per flow, not from the single newest run', () => {
  let dir: string;
  let root: string;
  let stderr: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-gate-'));
    root = join(dir, ReticleDir.ROOT);
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const flows = new FlowStore(createNodeFileSystem(), root, { now: () => 1 });
    for (const name of ['flow-a', 'flow-b']) {
      await flows.save({
        name,
        version: 1,
        steps: [
          {
            tool: 'reticle_act',
            stable: true,
            args: { by: QueryBy.TESTID, value: name, action: ActionType.CLICK, args: {} },
          },
        ],
      });
    }
    // The changed file exists and predates every run below; a missing changed file reads as deleted.
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'app.ts'), 'export const x = 1;\n');
    await utimes(join(dir, 'src', 'app.ts'), 0.1, 0.1);
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await removeTempDir(dir);
  });

  const gateOutput = async (
    files: string[] = ['src/app.ts'],
  ): Promise<{ uncovered: string[]; pass: boolean }> => {
    await handleGate(files, undefined);
    const line = stderr.map((s) => s.trim()).find((s) => s.includes('"event":"reticle_gate"'));
    expect(line).toBeDefined();
    return JSON.parse(line ?? '{}') as { uncovered: string[]; pass: boolean };
  };

  it('a newer drive run with no flows does not erase an earlier passing replay', async () => {
    const store = new RunStore(createNodeFileSystem(), root);
    await store.write(
      runAt('replay', 1000, [
        flowResult('flow-a', RunFlowStatus.PASS),
        flowResult('flow-b', RunFlowStatus.PASS),
      ]),
    );
    await store.write(runAt('drive', 2000, []));
    const out = await gateOutput();
    expect(out.uncovered).toEqual([]);
    expect(out.pass).toBe(true);
  });

  it('a flow whose newest result is a failure stays uncovered, even after an older pass', async () => {
    const store = new RunStore(createNodeFileSystem(), root);
    await store.write(
      runAt('old', 1000, [
        flowResult('flow-a', RunFlowStatus.PASS),
        flowResult('flow-b', RunFlowStatus.PASS),
      ]),
    );
    await store.write(runAt('new', 2000, [flowResult('flow-a', RunFlowStatus.FAIL)]));
    await store.write(runAt('drive', 3000, []));
    const out = await gateOutput();
    expect(out.uncovered).toEqual(['flow-a']);
    expect(out.pass).toBe(false);
  });

  const editSource = async (atMs: number): Promise<void> => {
    await mkdir(join(dir, 'src'), { recursive: true });
    const file = join(dir, 'src', 'app.ts');
    await writeFile(file, 'export const x = 1;\n');
    await utimes(file, atMs / 1000, atMs / 1000);
  };

  it('a pass older than the edit leaves the flow uncovered, a pass newer than it does not', async () => {
    const store = new RunStore(createNodeFileSystem(), root);
    await store.write(runAt('old', 1000, [flowResult('flow-a', RunFlowStatus.PASS)]));
    await store.write(runAt('fresh', 5000, [flowResult('flow-b', RunFlowStatus.PASS)]));
    await editSource(3000);
    const out = await gateOutput();
    expect(out.uncovered).toEqual(['flow-a']);
    expect(out.pass).toBe(false);
  });

  it('the status line counts the flows that pass and names the one an edit made stale', async () => {
    const store = new RunStore(createNodeFileSystem(), root);
    await store.write(
      runAt('replay', 1000, [
        flowResult('flow-a', RunFlowStatus.PASS),
        flowResult('flow-b', RunFlowStatus.PASS),
        flowResult('gone', RunFlowStatus.PASS),
      ]),
    );
    await store.write(runAt('drive', 2000, []));
    const fs = createNodeFileSystem();
    const flows = [
      { name: 'flow-a', steps: [] },
      { name: 'flow-b', steps: [] },
    ];
    const status = async (affected: string[], changed: string[]): Promise<string> => {
      stderr.length = 0;
      await emitBuddyStatus(fs, root, flows, affected, changed);
      const line = stderr.map((s) => s.trim()).find((s) => s.includes('"event":"reticle_buddy"'));
      return (JSON.parse(line ?? '{}') as { status: string }).status;
    };
    // The deleted flow's pass is not counted, and the drive run did not erase the replay.
    expect(await status([], [])).toBe('✓ 2/2 flows nominal');
    await editSource(3000);
    expect(await status(['flow-a'], ['src/app.ts'])).toBe('✗ 1 deviation: flow-a · 1 nominal');
  });

  // Re-save each flow with a step whose source is its own file, so the gate knows what it covers.
  const stampSources = async (sources: Record<string, string>): Promise<void> => {
    const flows = new FlowStore(createNodeFileSystem(), root, { now: () => 1 });
    const stamp = async (name: string, file: string): Promise<void> => {
      await flows.save({
        name,
        version: 1,
        steps: [
          {
            tool: 'reticle_act',
            stable: true,
            args: {
              by: QueryBy.TESTID,
              value: name,
              action: ActionType.CLICK,
              args: {},
              source: { file, line: 1 },
            },
          },
        ],
      });
    };
    await Promise.all(Object.entries(sources).map(([name, file]) => stamp(name, file)));
  };

  const touch = async (rel: string, atMs: number): Promise<void> => {
    await mkdir(join(dir, 'src'), { recursive: true });
    const file = join(dir, rel);
    await writeFile(file, 'export const x = 1;\n');
    await utimes(file, atMs / 1000, atMs / 1000);
  };

  it('A and B replay green, an edit lands, only B is replayed: the gate reports A uncovered', async () => {
    await stampSources({ 'flow-a': 'src/app.ts', 'flow-b': 'src/app.ts' });
    const store = new RunStore(createNodeFileSystem(), root);
    await store.write(
      runAt('both', 1000, [
        flowResult('flow-a', RunFlowStatus.PASS),
        flowResult('flow-b', RunFlowStatus.PASS),
      ]),
    );
    await touch('src/app.ts', 1500);
    await store.write(runAt('only-b', 2000, [flowResult('flow-b', RunFlowStatus.PASS)]));
    const out = await gateOutput();
    expect(out.uncovered).toEqual(['flow-a']);
    expect(out.pass).toBe(false);
  });

  it('an edit outside a flow own sources does not invalidate its pass', async () => {
    await stampSources({ 'flow-a': 'src/a.ts', 'flow-b': 'src/b.ts' });
    const store = new RunStore(createNodeFileSystem(), root);
    await store.write(
      runAt('both', 1000, [
        flowResult('flow-a', RunFlowStatus.PASS),
        flowResult('flow-b', RunFlowStatus.PASS),
      ]),
    );
    await touch('src/a.ts', 500);
    await touch('src/b.ts', 1500);
    // Both files changed; flow-a's source is older than its pass, flow-b's is newer than its pass.
    const out = await gateOutput(['src/a.ts', 'src/b.ts']);
    expect(out.uncovered).toEqual(['flow-b']);
  });

  it('a changed source file that was deleted leaves its flow uncovered', async () => {
    await stampSources({ 'flow-a': 'src/gone.ts', 'flow-b': 'src/b.ts' });
    const store = new RunStore(createNodeFileSystem(), root);
    await store.write(
      runAt('both', 1000, [
        flowResult('flow-a', RunFlowStatus.PASS),
        flowResult('flow-b', RunFlowStatus.PASS),
      ]),
    );
    await touch('src/b.ts', 500);
    const out = await gateOutput(['src/gone.ts', 'src/b.ts']);
    expect(out.uncovered).toEqual(['flow-a']);
    expect(out.pass).toBe(false);
  });

  const bothGreen = async (): Promise<void> => {
    const store = new RunStore(createNodeFileSystem(), root);
    await store.write(
      runAt('both', 1000, [
        flowResult('flow-a', RunFlowStatus.PASS),
        flowResult('flow-b', RunFlowStatus.PASS),
      ]),
    );
  };

  it('a repo-root-relative changed path still finds the flow own package-relative source', async () => {
    await stampSources({ 'flow-a': 'src/app.ts', 'flow-b': 'src/other.ts' });
    await bothGreen();
    await touch('src/app.ts', 1500);
    // The gate runs in the package directory; the changed path is repo-root-relative.
    const out = await gateOutput([`${basename(dir)}/src/app.ts`]);
    expect(out.uncovered).toEqual(['flow-a']);
  });

  it('a deleted source does not pick up an unrelated file with the same name further up', async () => {
    await stampSources({ 'flow-a': 'lib/util.ts', 'flow-b': 'src/other.ts' });
    await bothGreen();
    // lib/util.ts is gone; an older util.ts sits in cwd and must not stand in for it.
    await touch('util.ts', 500);
    const out = await gateOutput(['lib/util.ts']);
    expect(out.uncovered).toEqual(['flow-a']);
    expect(out.pass).toBe(false);
  });

  it('an absolute source stamp matches a repo-relative changed path', async () => {
    await stampSources({ 'flow-a': join(dir, 'src', 'app.ts'), 'flow-b': 'src/other.ts' });
    await bothGreen();
    await touch('src/app.ts', 1500);
    const out = await gateOutput(['src/app.ts']);
    expect(out.uncovered).toEqual(['flow-a']);
  });

  it('watch keeps a flow stale from the source mtime on disk, after an unrelated save and at startup', async () => {
    await stampSources({ 'flow-a': 'src/app.ts', 'flow-b': 'src/other.ts' });
    await bothGreen();
    await touch('src/other.ts', 500);
    await touch('src/app.ts', 1500);
    const fs = createNodeFileSystem();
    const flows = [
      {
        name: 'flow-a',
        steps: [
          {
            tool: 'reticle_act',
            anchor: { kind: 'testid', value: 'a' },
            source: { file: 'src/app.ts', line: 1 },
          },
        ],
      },
      {
        name: 'flow-b',
        steps: [
          {
            tool: 'reticle_act',
            anchor: { kind: 'testid', value: 'b' },
            source: { file: 'src/other.ts', line: 1 },
          },
        ],
      },
    ];
    const status = async (affected: string[], changed: string[]): Promise<string> => {
      stderr.length = 0;
      await emitBuddyStatus(fs, root, flows as never, affected, changed);
      const line = stderr.map((s) => s.trim()).find((s) => s.includes('"event":"reticle_buddy"'));
      return (JSON.parse(line ?? '{}') as { status: string }).status;
    };
    // Startup: nothing changed in a batch, yet the earlier edit to flow-a's source still shows.
    expect(await status([], [])).toBe('✗ 1 deviation: flow-a · 1 nominal');
    // An unrelated save does not make it nominal again.
    expect(await status(['flow-b'], ['src/other.ts'])).toBe('✗ 1 deviation: flow-a · 1 nominal');
  });
});
