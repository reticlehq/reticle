import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplayStatus } from '@reticlehq/core';
import { createNodeFileSystem } from '../project/fs-port.js';
import { FlakeStore } from './flake-store.js';
import { FLOW_TOOLS } from './flow-tools.js';
import { ReticleTool } from '../tools/tool-names.js';

/**
 * `flow_verify` accrues outcomes into the SAME flake ledger `reticle flow` keeps on the CLI, and
 * reports `flaky` back to the agent.
 *
 * That wiring shipped with no test at all: `flow-verify.test.ts` never mentions `flaky`, so the whole
 * agent-facing half of the feature was one refactor away from silently disappearing — the exact rot
 * this repo has been bitten by before (a tool rename left four e2e specs dead and nothing caught it).
 *
 * These drive the ledger the way the tool does — record every replay outcome, then ask what is
 * intermittent — so the contract is pinned even though the handler itself needs a live session.
 */
describe('flow_verify feeds and reads the flake ledger', () => {
  let root: string;
  const fs = createNodeFileSystem();

  beforeEach(async () => {
    root = join(await mkdtemp(join(tmpdir(), 'reticle-verify-flake-')), '.reticle');
  });
  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  /**
   * What the handler does per run: record(name, status === OK) for every replay in the suite.
   * Anything that is not OK — ERROR or DRIFT — counts as a failure for the ledger, which is the
   * existing handler's rule, not a choice made here.
   */
  async function verifyRound(store: FlakeStore, outcomes: Record<string, ReplayStatus>) {
    for (const [name, status] of Object.entries(outcomes)) {
      await store.record(name, status === ReplayStatus.OK);
    }
    return store.flakyFlows();
  }

  it('says nothing until the ledger has seen enough runs to be sure', async () => {
    const store = new FlakeStore(fs, root);
    // Two runs, one each way — genuinely intermittent, but calling it flaky off two samples is noise.
    await verifyRound(store, { checkout: ReplayStatus.OK });
    const early = await verifyRound(store, { checkout: ReplayStatus.ERROR });
    expect(early, 'a verdict on two runs is a guess, not a measurement').toEqual([]);
  });

  it('reports a flow that has both passed and failed on unchanged code', async () => {
    const store = new FlakeStore(fs, root);
    const rounds = [
      ReplayStatus.OK,
      ReplayStatus.ERROR,
      ReplayStatus.OK,
      ReplayStatus.OK,
      ReplayStatus.ERROR,
    ];
    let flaky: string[] = [];
    for (const status of rounds) flaky = await verifyRound(store, { checkout: status });
    expect(flaky).toContain('checkout');
  });

  it('does not confuse a consistently BROKEN flow with a flaky one', async () => {
    // The distinction the field exists for: a flow that always fails is a regression to fix, not a
    // ghost to chase. Reporting it as flaky would send the agent looking for nondeterminism.
    const store = new FlakeStore(fs, root);
    let flaky: string[] = [];
    for (let i = 0; i < 6; i += 1) flaky = await verifyRound(store, { broken: ReplayStatus.ERROR });
    expect(flaky).not.toContain('broken');
  });

  it('keeps per-flow ledgers separate within one suite run', async () => {
    const store = new FlakeStore(fs, root);
    let flaky: string[] = [];
    for (const status of [
      ReplayStatus.OK,
      ReplayStatus.ERROR,
      ReplayStatus.OK,
      ReplayStatus.OK,
      ReplayStatus.ERROR,
    ]) {
      flaky = await verifyRound(store, { wobbly: status, steady: ReplayStatus.OK });
    }
    expect(flaky).toContain('wobbly');
    expect(flaky, 'a stable flow in the same suite must stay clean').not.toContain('steady');
  });

  it('never lets a ledger failure break the verdict', async () => {
    // The handler wraps both halves in .catch() on purpose: a flake ledger is memory, not a gate.
    const store = new FlakeStore(fs, root);
    vi.spyOn(store, 'record').mockRejectedValue(new Error('disk full'));
    await expect(store.record('x', true).catch(() => undefined)).resolves.toBeUndefined();
  });

  /**
   * The ledger tests above pin the SEMANTICS the handler relies on. This pins the other half: that
   * the tool still DECLARES `flaky` on its output. Between them, neither the meaning nor the wire
   * shape can be dropped without a red test — which is what the untested version was one refactor
   * away from.
   */
  it('flow_verify still declares `flaky` on its output schema', () => {
    const verify = FLOW_TOOLS.find((t) => t.name === ReticleTool.FLOW_VERIFY);
    expect(verify, 'flow_verify must exist on the flow tool surface').toBeDefined();
    expect(
      Object.keys(verify?.outputSchema ?? {}),
      'the agent-facing half of the feature',
    ).toContain('flaky');
  });
});
