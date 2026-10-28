/**
 * `reticle gate` sends one `gate_completed` on every exit path.
 *
 * THE DEFECT THIS EXISTS FOR: the gate sent `cli_command_run` and nothing about how it ended, so a
 * repository that runs it in CI many times a day could not be told apart from one whose every run
 * failed.
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
import { GateOutcome } from '@reticlehq/core/telemetry';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { FlowStore } from '@/language/flows/flows.js';
import { RunStore } from '@/judgement/runs/artifact/run-store.js';
import { buildVerificationRun } from '@/judgement/runs/artifact/build-verification-run.js';
import { knownRegression } from './known-regression.js';
import { GATE_SKIP_ENV } from './answers/gate-hook-message.js';
import { handleGate } from './cli-flow-commands.js';

vi.mock('./known-regression.js', () => ({ knownRegression: vi.fn() }));

const FLOWS = ['flow-a', 'flow-b'] as const;
const reportGateCompleted = vi.fn();
const CHANGED = 'src/app.ts';

const runOf = (status: RunFlowStatus) =>
  buildVerificationRun(
    {
      runId: 'replay',
      durationMs: 100,
      profile: RunProfile.DEV,
      project: { name: 'demo', framework: RunFramework.REACT },
      agent: { id: 'a', kind: RunAgentKind.CODING_AGENT },
      trigger: { kind: RunTrigger.EDIT },
      changedFiles: [],
      flows: FLOWS.map((name) => ({ name, status, steps: 1, durationMs: 1 })),
      checks: [],
      risks: [],
      evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
    },
    () => 5000,
  );

describe('handleGate reports how it ended', () => {
  let dir: string;
  let root: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-gate-completed-'));
    root = join(dir, ReticleDir.ROOT);
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.mocked(knownRegression).mockResolvedValue({});
    reportGateCompleted.mockClear();
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await removeTempDir(dir);
  });

  const saveFlows = async (status: RunFlowStatus): Promise<void> => {
    const flows = new FlowStore(createNodeFileSystem(), root, { now: () => 1 });
    await Promise.all(
      FLOWS.map((name) =>
        flows.save({
          name,
          version: 1,
          steps: [
            {
              tool: 'reticle_act',
              stable: true,
              args: { by: QueryBy.TESTID, value: name, action: ActionType.CLICK, args: {} },
            },
          ],
        }),
      ),
    );
    await new RunStore(createNodeFileSystem(), root).write(runOf(status));
    // The changed file exists and predates the run: a missing changed file reads as deleted.
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, CHANGED), 'export const x = 1;\n');
    await utimes(join(dir, CHANGED), 0.1, 0.1);
  };

  it('sends nothing_to_check when no flow is saved', async () => {
    await handleGate([], undefined, false, false, reportGateCompleted);
    expect(reportGateCompleted.mock.calls).toEqual([
      [{ outcome: GateOutcome.NOTHING_TO_CHECK, flowsChecked: 0 }],
    ]);
  });

  it('sends pass with the count of flows it judged', async () => {
    await saveFlows(RunFlowStatus.PASS);
    await handleGate([CHANGED], undefined, false, false, reportGateCompleted);
    expect(process.exitCode).toBeUndefined();
    expect(reportGateCompleted.mock.calls).toEqual([
      [{ outcome: GateOutcome.PASS, flowsChecked: FLOWS.length }],
    ]);
  });

  it('sends fail when an affected flow has no passing run', async () => {
    await saveFlows(RunFlowStatus.FAIL);
    await handleGate([CHANGED], undefined, false, false, reportGateCompleted);
    expect(reportGateCompleted.mock.calls).toEqual([
      [{ outcome: GateOutcome.FAIL, flowsChecked: FLOWS.length }],
    ]);
  });

  it('sends regression when the platform knows a broken flow', async () => {
    await saveFlows(RunFlowStatus.PASS);
    vi.mocked(knownRegression).mockResolvedValue({ broken: ['flow-a'] });
    await handleGate([CHANGED], undefined, false, false, reportGateCompleted);
    expect(reportGateCompleted.mock.calls).toEqual([
      [{ outcome: GateOutcome.REGRESSION, flowsChecked: FLOWS.length }],
    ]);
  });

  it('sends error, with no flow count, when the gate itself breaks', async () => {
    vi.mocked(knownRegression).mockRejectedValue(new Error('disk gone'));
    await handleGate([], undefined, false, false, reportGateCompleted);
    expect(reportGateCompleted.mock.calls).toEqual([[{ outcome: GateOutcome.ERROR }]]);
  });

  it('reports what the gate judged, not the exit a skip in a hook forces', async () => {
    await saveFlows(RunFlowStatus.FAIL);
    vi.stubEnv(GATE_SKIP_ENV, '1');
    await handleGate([CHANGED], undefined, true, false, reportGateCompleted);
    vi.unstubAllEnvs();
    expect(reportGateCompleted.mock.calls).toEqual([
      [{ outcome: GateOutcome.FAIL, flowsChecked: FLOWS.length }],
    ]);
  });
});
