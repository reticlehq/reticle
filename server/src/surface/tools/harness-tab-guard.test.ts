/**
 * One driver per tab. With the Harness clicking through a page, an agent clicking too is two hands
 * on one mouse, and neither result means anything. The agent's action is refused, and told how to
 * wait for the Harness or stop it; the Harness's own actions, and the agent's reads, still run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import type { ToolDeps } from './tool-kit.js';
import { TOOLS } from './tools.js';
import { runTool } from './invoke-tool.js';
import { DriveOrigin, forgetDrives, startDrive } from '@/features/harness/drive-runs.js';
import { runDrivenBy } from '@/hooks/driven-by.js';

afterEach(() => forgetDrives());

const tab = { id: 's1' };
const deps = { sessions: { resolve: () => tab, get: () => tab } } as unknown as ToolDeps;
const act = TOOLS.find((t) => ReticleTool.ACT_AND_WAIT === t.name);

const harnessDriving = (): void => {
  startDrive({
    harness: 'h1',
    runId: 'harness-h1',
    origin: DriveOrigin.AGENT,
    sessionId: 's1',
    now: () => 0,
    persist: () => Promise.resolve(),
    run: () => new Promise(() => undefined),
  });
};

describe('one driver per tab', () => {
  it("refuses the agent's action while the Harness drives its tab, and says how to wait or stop", async () => {
    if (act === undefined) throw new Error('no act_and_wait');
    harnessDriving();
    const answer = (await runTool(act, deps, { ref: 'e1', action: 'click' })) as { error?: string };
    expect(answer.error).toMatch(/Reticle Harness is driving this tab now \(run harness-h1\)/);
    expect(answer.error).toMatch(/runId: "harness-h1"/);
    expect(answer.error).toMatch(/stop: true/);
  });

  it("never refuses the Harness's own action in the tab it drives", async () => {
    if (act === undefined) throw new Error('no act_and_wait');
    harnessDriving();
    const answer = await runDrivenBy({ harness: 'h1', driver: 'jev' }, () =>
      runTool(act, deps, { ref: 'e1', action: 'click' }).catch((e: unknown) => ({ thrown: e })),
    );
    expect(JSON.stringify(answer)).not.toMatch(/Harness is driving this tab now/);
  });
});
