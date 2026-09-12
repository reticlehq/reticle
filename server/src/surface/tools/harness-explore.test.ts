import { describe, expect, it } from 'vitest';
import { ReticleEnv } from '@reticlehq/core';
import type { ToolDeps } from './tools.js';
import {
  DEFAULT_MAX_STEPS,
  FINISH_TOOL,
  type ModelDriver,
  type ModelTurn,
} from '../../features/harness/harness.js';
import {
  exploreApp,
  harnessAvailable,
  maxStepsFromEnv,
  MSG_NO_HARNESS_KEY,
} from './harness-explore.js';

/** A flow store that answers a list, which is the only part of `deps` exploring reads. */
function depsWithFlows(...lists: readonly string[][]): ToolDeps {
  let call = 0;
  return {
    flows: {
      list: () => {
        const answer = lists[Math.min(call, lists.length - 1)] ?? [];
        call += 1;
        return Promise.resolve([...answer]);
      },
    },
  } as unknown as ToolDeps;
}

function finishing(summary: string): ModelDriver {
  return {
    turn: (): Promise<ModelTurn> =>
      Promise.resolve({
        text: '',
        calls: [{ id: '1', name: FINISH_TOOL.name, args: { summary } }],
      }),
  };
}

describe('exploring an app', () => {
  it('reports the flows that now exist and did not before', async () => {
    const result = await exploreApp(
      depsWithFlows(['login'], ['login', 'checkout']),
      {},
      { driver: finishing('drove checkout') },
    );

    expect(result.savedFlows).toEqual(['checkout']);
    expect(result.drive.summary).toBe('drove checkout');
  });

  it('believes the disk and not the model about what was saved', async () => {
    const result = await exploreApp(
      depsWithFlows(['login'], ['login']),
      {},
      { driver: finishing('I saved a flow called checkout') },
    );

    // The model said it saved one. Nothing appeared. The answer is what is on disk.
    expect(result.savedFlows).toEqual([]);
  });

  it('refuses to invent a driver when no model is configured', async () => {
    await expect(exploreApp(depsWithFlows([]), {})).rejects.toThrow(MSG_NO_HARNESS_KEY);
  });

  it('is available exactly when a key is set', () => {
    expect(harnessAvailable({})).toBe(false);
    expect(harnessAvailable({ [ReticleEnv.HARNESS_KEY]: 'sk-x' })).toBe(true);
  });
});

describe('the step budget', () => {
  it('defaults when unset', () => {
    expect(maxStepsFromEnv({})).toBe(DEFAULT_MAX_STEPS);
  });

  it('is a budget somebody can actually change', () => {
    expect(maxStepsFromEnv({ [ReticleEnv.HARNESS_MAX_STEPS]: '8' })).toBe(8);
  });

  it('ignores a value that would drive nothing, rather than reporting a run over an untouched app', () => {
    expect(maxStepsFromEnv({ [ReticleEnv.HARNESS_MAX_STEPS]: '0' })).toBe(DEFAULT_MAX_STEPS);
    expect(maxStepsFromEnv({ [ReticleEnv.HARNESS_MAX_STEPS]: 'lots' })).toBe(DEFAULT_MAX_STEPS);
  });
});
