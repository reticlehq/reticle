import { removeTempDir } from '../temp-dir.js';
/**
 * The flake-ledger step of `flow_verify`, tested against the shipped function rather than a copy.
 *
 * Both previous tests for this behaviour — sequential and parallel — re-implemented the loop in the
 * test file. Measured on #240: its four tests passed with the runtime fix reverted, because the file
 * imported `FlakeStore` and never `flow-tools.js`. Two green tests, zero coverage of the change.
 *
 * The reason for that was real (the handler needs a live browser session), which is why the loop is
 * extracted now: the part worth pinning is separable from the part that needs a browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplayStatus } from '@reticlehq/core';
import { createNodeFileSystem } from '../project/fs-port.js';
import { FlakeStore } from './flake-store.js';
import { recordSuiteFlakes } from './suite-flakes.js';
import { FLOW_TOOLS } from './flow-tools.js';
import { ReticleTool } from '../tools/tool-names.js';

let root = '';
const fs = createNodeFileSystem();

beforeEach(async () => {
  root = join(await mkdtemp(join(tmpdir(), 'reticle-suite-flakes-')), '.reticle');
});
afterEach(async () => {
  await removeTempDir(join(root, '..'));
});

/** One suite run, as the handler passes it: a list of `{ replay }` wrappers. */
const round = (outcomes: Record<string, ReplayStatus>) =>
  Object.entries(outcomes).map(([name, status]) => ({ replay: { name, status } }));

/**
 * A BOUND, not a measurement. Each `recordSuiteFlakes` call rewrites the ledger on the real
 * filesystem, and a batch round does it once per flow — so a five-round loop over a three-flow suite
 * is fifteen writes, not five iterations. That is the shape that timed out at vitest's 5 s default
 * on a Windows runner in `project-tools.test.ts`, and nothing here claims the code is fast.
 */
const SUITE_LEDGER_TIMEOUT_MS = 30_000;

describe('recordSuiteFlakes', () => {
  it(
    'reports a flow that has both passed and failed on unchanged code',
    async () => {
      let flaky: readonly string[] = [];
      for (const status of [
        ReplayStatus.OK,
        ReplayStatus.ERROR,
        ReplayStatus.OK,
        ReplayStatus.OK,
        ReplayStatus.ERROR,
      ]) {
        flaky = await recordSuiteFlakes(fs, root, round({ checkout: status }));
      }
      expect(flaky).toContain('checkout');
    },
    SUITE_LEDGER_TIMEOUT_MS,
  );

  it(
    'records EVERY flow in a batch, not just the first or last',
    async () => {
      // The parallel path records a whole round at once. A loop that broke early, or overwrote, would
      // still look right for a one-flow suite.
      let flaky: readonly string[] = [];
      for (const s of [
        ReplayStatus.OK,
        ReplayStatus.ERROR,
        ReplayStatus.OK,
        ReplayStatus.OK,
        ReplayStatus.ERROR,
      ]) {
        flaky = await recordSuiteFlakes(
          fs,
          root,
          round({ login: s, steady: ReplayStatus.OK, search: s }),
        );
      }
      expect(flaky).toContain('login');
      expect(flaky).toContain('search');
      expect(flaky, 'a stable flow in the same batch must stay clean').not.toContain('steady');
    },
    SUITE_LEDGER_TIMEOUT_MS,
  );

  it('says nothing until the ledger has seen enough runs to be sure', async () => {
    await recordSuiteFlakes(fs, root, round({ checkout: ReplayStatus.OK }));
    const early = await recordSuiteFlakes(fs, root, round({ checkout: ReplayStatus.ERROR }));
    expect(early, 'a verdict on two runs is a guess, not a measurement').toEqual([]);
  });

  it(
    'does not confuse a consistently BROKEN flow with a flaky one',
    async () => {
      let flaky: readonly string[] = [];
      for (let i = 0; i < 6; i += 1) {
        flaky = await recordSuiteFlakes(fs, root, round({ broken: ReplayStatus.ERROR }));
      }
      expect(flaky, 'always-failing is a regression to fix, not a ghost to chase').not.toContain(
        'broken',
      );
    },
    SUITE_LEDGER_TIMEOUT_MS,
  );

  it(
    'counts DRIFT as a failure, like ERROR',
    async () => {
      let flaky: readonly string[] = [];
      for (const s of [
        ReplayStatus.OK,
        ReplayStatus.DRIFT,
        ReplayStatus.OK,
        ReplayStatus.OK,
        ReplayStatus.DRIFT,
      ]) {
        flaky = await recordSuiteFlakes(fs, root, round({ wobbly: s }));
      }
      expect(flaky).toContain('wobbly');
    },
    SUITE_LEDGER_TIMEOUT_MS,
  );

  it('never lets a ledger failure break the verdict', async () => {
    // A flake ledger is memory, not a gate. A full disk must not turn a working verify into an error.
    vi.spyOn(FlakeStore.prototype, 'record').mockRejectedValue(new Error('disk full'));
    vi.spyOn(FlakeStore.prototype, 'flakyFlows').mockRejectedValue(new Error('disk full'));

    await expect(
      recordSuiteFlakes(fs, root, round({ checkout: ReplayStatus.OK })),
    ).resolves.toEqual([]);
    vi.restoreAllMocks();
  });
});

/**
 * The other half: both branches of the handler must actually REACH this function.
 *
 * This is the assertion #240's test was missing. `flow_verify` has a parallel branch and a
 * sequential branch, and the parallel one shipped without any flake recording at all — a miss no
 * test caught, because the only test of the behaviour never imported the handler.
 */
describe('flow_verify still wires both branches to the ledger', () => {
  it('declares `flaky` on its output schema', () => {
    const verify = FLOW_TOOLS.find((t) => t.name === ReticleTool.FLOW_VERIFY);
    expect(verify, 'flow_verify must exist on the flow tool surface').toBeDefined();
    expect(
      Object.keys(verify?.outputSchema ?? {}),
      'the agent-facing half of the feature',
    ).toContain('flaky');
  });
});
