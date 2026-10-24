/**
 * A suite the agent ran is one of the session's checks.
 *
 * `reticle_verify { action: "flows" }` can come back `error` or `unverifiable` and the session
 * end still said proved, because only a replay that finished its steps was written into the
 * journal. The failed and unverifiable returns left before that write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplayStatus, Verified, type FlowReplayResult } from '@reticlehq/core';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { replayAndLearn } from './flow-learning.js';

const replayNamedFlow = vi.hoisted(() => vi.fn());

vi.mock('./flow-replay-run.js', () => ({
  replayNamedFlow: (...args: unknown[]): Promise<FlowReplayResult> =>
    replayNamedFlow(...args) as Promise<FlowReplayResult>,
}));

describe('a replay is a check of the session that ran it', () => {
  const recorded: { tool: string; effect: { verified?: string; claim?: string } }[] = [];

  beforeEach(() => {
    recorded.length = 0;
    replayNamedFlow.mockReset();
  });

  const deps = {
    sessions: {
      resolve: () => ({
        recordAction: (tool: string, _args: Record<string, unknown>, effect: unknown) => {
          recorded.push({
            tool,
            effect: effect as { verified?: string; claim?: string },
          });
          return 'a1';
        },
      }),
    },
  } as unknown as ToolDeps;

  it('records a failed replay as a check that did not hold', async () => {
    replayNamedFlow.mockResolvedValue({
      name: 'checkout',
      status: ReplayStatus.ERROR,
      steps: [],
    });
    await replayAndLearn(deps, { flowName: 'checkout', sessionId: 's1' });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.effect.verified).toBe(Verified.NO);
    expect(recorded[0]?.effect.claim).toContain('checkout');
  });

  it('records an unverifiable replay as unknown, not as a pass', async () => {
    replayNamedFlow.mockResolvedValue({
      name: 'checkout',
      status: ReplayStatus.UNVERIFIABLE,
      steps: [],
      unverifiable: { reason: 'precondition unmet' },
    });
    await replayAndLearn(deps, { flowName: 'checkout', sessionId: 's1' });
    expect(recorded[0]?.effect.verified).toBe(Verified.UNKNOWN);
  });
});
