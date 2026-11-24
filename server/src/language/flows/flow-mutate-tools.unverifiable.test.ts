import { describe, expect, it, vi } from 'vitest';
import { ReplayStatus } from '@reticlehq/core';
import { MutationOutcome } from 'open-verification';
import type { ToolDeps } from '@/surface/tools/tools.js';

/**
 * A replay that could not be graded is not a red replay (#1654).
 *
 * Replay reports `unverifiable` when a step failed on a page that had not hydrated. With the break
 * applied, that is a page the replay could not judge, not a flow that noticed the break. The tool
 * must not count it as `fail`, because a `fail` after a `pass` grades the flow KILLED.
 */

const replayStatuses: ReplayStatus[] = [];
const NOT_HYDRATED = 'step 1 failed while the page had not hydrated';

vi.mock('./flow-replay-run.js', () => ({
  replayNamedFlow: () => {
    const status = replayStatuses.shift() ?? ReplayStatus.OK;
    return Promise.resolve({
      name: 'f',
      status,
      steps: [],
      ...(ReplayStatus.UNVERIFIABLE === status ? { unverifiable: { reason: NOT_HYDRATED } } : {}),
    });
  },
}));

vi.mock('@/surface/tools/lease-tools.js', () => ({
  sessionMutationPort: () =>
    Promise.resolve({
      mutate: () => Promise.resolve({ mutation: 'request-fails:/api/o' }),
      revert: () => Promise.resolve(),
    }),
}));

const { FLOW_MUTATE_TOOL } = await import('./flow-mutate-tools.js');

const deps = (): ToolDeps =>
  ({
    sessions: { resolve: () => undefined },
    flows: {
      load: () =>
        Promise.resolve({
          ok: true,
          value: {
            version: 1,
            name: 'f',
            createdAt: 0,
            steps: [{ tool: 'act', args: {}, expect: { kind: 'net', urlContains: '/api/o' } }],
          },
        }),
    },
  }) as unknown as ToolDeps;

describe('the flow-mutation tool, when a replay could not be graded', () => {
  it('reports inconclusive with the reason, not killed', async () => {
    replayStatuses.splice(0, replayStatuses.length, ReplayStatus.OK, ReplayStatus.UNVERIFIABLE);
    const result = (await FLOW_MUTATE_TOOL.handler(deps(), { flowName: 'f' })) as {
      outcome?: string;
      because?: string;
    };
    expect(result.outcome).toBe(MutationOutcome.INCONCLUSIVE);
    expect(result.because).toContain(NOT_HYDRATED);
  });

  it('still grades a red replay with the break as killed', async () => {
    replayStatuses.splice(0, replayStatuses.length, ReplayStatus.OK, ReplayStatus.ERROR);
    const result = (await FLOW_MUTATE_TOOL.handler(deps(), { flowName: 'f' })) as {
      outcome?: string;
    };
    expect(result.outcome).toBe(MutationOutcome.KILLED);
  });
});
