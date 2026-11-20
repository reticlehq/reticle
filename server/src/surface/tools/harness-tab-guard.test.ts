/**
 * One driver per tab. With the Harness clicking through a page, an agent clicking too is two hands
 * on one mouse, and neither result means anything. The agent's action is refused, and told how to
 * wait for the Harness or stop it; the Harness's own actions, and the agent's reads, still run.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ReticleTool, SessionState } from '@reticlehq/core';
import type { Session } from '@/portal/session/session.js';
import type { ToolDef, ToolDeps } from './tool-kit.js';
import { TOOLS } from './tools.js';
import { runTool } from './invoke-tool.js';
import { DriveOrigin, forgetDrives, startDrive } from '@/features/harness/drive-runs.js';
import { runDrivenBy } from '@/hooks/driven-by.js';

afterEach(() => forgetDrives());

// Enough of a session for a call to run to the end, so a test reads a result instead of a throw.
const tab: Partial<Session> = {
  id: 's1',
  health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
  getState: () => SessionState.ACTIVE,
  drainInbox: () => [],
  takeSessionLease: () => undefined,
  ageWarning: () => undefined,
};
const deps = {
  sessions: { resolve: () => tab, get: () => tab, list: () => [{ sessionId: 's1' }] },
} as unknown as ToolDeps;
const act = TOOLS.find((t) => ReticleTool.ACT_AND_WAIT === t.name);

/** A tool under `name` whose handler only answers, so the guard is the one thing deciding. */
const answering = (name: string): ToolDef => ({
  name,
  description: '',
  inputSchema: {},
  handler: () => Promise.resolve({ ran: true }),
});

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
    harnessDriving();
    const answer = await runDrivenBy({ harness: 'h1', driver: 'jev' }, () =>
      runTool(answering(ReticleTool.ACT_AND_WAIT), deps, { ref: 'e1', action: 'click' }),
    );
    expect(answer).toMatchObject({ ran: true });
    expect(answer).not.toHaveProperty('error');
  });

  it("still runs the agent's reads in the tab the Harness drives", async () => {
    harnessDriving();
    for (const read of [ReticleTool.OBSERVE, ReticleTool.SNAPSHOT]) {
      const answer = await runTool(answering(read), deps, {});
      expect(answer, read).toMatchObject({ ran: true });
      expect(answer, read).not.toHaveProperty('error');
    }
  });
});
