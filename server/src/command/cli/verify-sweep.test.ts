/**
 * `reticle verify --sweep` judges every step, also after one fails, so the results score counts
 * every step rather than stopping at the first broken one.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseCliArgs } from './cli-parse.js';
import { createRunnerPort } from '@/judgement/runs/runner-port.js';
import { replayAndLearn } from '@/language/flows/flow-learning.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';

vi.mock('@/language/flows/flow-learning.js', () => ({
  replayAndLearn: vi.fn(() => Promise.resolve({})),
}));

describe('reticle verify --sweep', () => {
  it('survives the whole command line, and is absent unless given', () => {
    expect(parseCliArgs(['verify', 'http://localhost:3000', '--sweep'], 4400)).toMatchObject({
      sweep: true,
    });
    expect(parseCliArgs(['verify', 'http://localhost:3000'], 4400)).not.toHaveProperty('sweep');
  });

  it('reaches every flow the run replays, and only when asked', async () => {
    const deps = {} as ToolDeps;
    await createRunnerPort(deps, undefined, { sweep: true }).replayFlow('a');
    expect(vi.mocked(replayAndLearn)).toHaveBeenLastCalledWith(deps, {
      flowName: 'a',
      sweep: true,
    });
    await createRunnerPort(deps).replayFlow('a');
    expect(vi.mocked(replayAndLearn)).toHaveBeenLastCalledWith(deps, { flowName: 'a' });
  });
});
