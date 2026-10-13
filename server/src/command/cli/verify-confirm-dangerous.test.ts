/**
 * A checkout flow could never pass `reticle verify`: its "Place order" button is guarded as
 * destructive on replay, and verify had no way to acknowledge it. `--confirm-dangerous` does, for
 * this run only; the guard still holds for every run that does not say so.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseVerifySuffix } from './cli-parse-verify.js';
import { createRunnerPort } from '@/judgement/runs/runner-port.js';
import { replayAndLearn } from '@/language/flows/flow-learning.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';

vi.mock('@/language/flows/flow-learning.js', () => ({
  replayAndLearn: vi.fn(() => Promise.resolve({})),
}));

describe('reticle verify --confirm-dangerous', () => {
  it('is read off the command line, and absent unless given', () => {
    const given = parseVerifySuffix(['http://localhost:3000', '--confirm-dangerous'], 4400);
    expect(given).toMatchObject({ kind: 'ok', confirmDangerous: true });
    const plain = parseVerifySuffix(['http://localhost:3000'], 4400);
    expect(plain).not.toHaveProperty('confirmDangerous');
  });

  it('reaches every flow the run replays, and only when asked', async () => {
    const deps = {} as ToolDeps;
    await createRunnerPort(deps, undefined, { confirmDangerous: true }).replayFlow('place-order');
    expect(vi.mocked(replayAndLearn)).toHaveBeenLastCalledWith(deps, {
      flowName: 'place-order',
      confirmDangerous: true,
    });
    await createRunnerPort(deps).replayFlow('place-order');
    expect(vi.mocked(replayAndLearn)).toHaveBeenLastCalledWith(deps, { flowName: 'place-order' });
  });
});
