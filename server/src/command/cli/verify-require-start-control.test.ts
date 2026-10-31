/**
 * A change that removed a feature's entry control graded `unknown` under verify, never `no`, so a
 * gate that blocks only on `no` let it through (#2061). `--require-start-control` asks that this
 * case fail; without it the rule is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseCliArgs } from './cli-parse.js';
import { parseVerifySuffix } from './cli-parse-verify.js';
import { createRunnerPort } from '@/judgement/runs/runner-port.js';
import { replayAndLearn } from '@/language/flows/flow-learning.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';

vi.mock('@/language/flows/flow-learning.js', () => ({
  replayAndLearn: vi.fn(() => Promise.resolve({})),
}));

describe('reticle verify --require-start-control', () => {
  it('is read off the command line, and absent unless given', () => {
    const given = parseVerifySuffix(['http://localhost:3000', '--require-start-control'], 4400);
    expect(given).toMatchObject({ kind: 'ok', requireStartControl: true });
    const plain = parseVerifySuffix(['http://localhost:3000'], 4400);
    expect(plain).not.toHaveProperty('requireStartControl');
  });

  it('survives the whole command line, not only the verify suffix', () => {
    // The suffix parser read the flag and the CLI parser then dropped it, so verify ran without it.
    expect(
      parseCliArgs(['verify', 'http://localhost:3000', '--require-start-control'], 4400),
    ).toMatchObject({ requireStartControl: true });
  });

  it('reaches every flow the run replays, and only when asked', async () => {
    const deps = {} as ToolDeps;
    await createRunnerPort(deps, undefined, { requireStartControl: true }).replayFlow('sort');
    expect(vi.mocked(replayAndLearn)).toHaveBeenLastCalledWith(deps, {
      flowName: 'sort',
      requireStartControl: true,
    });
    await createRunnerPort(deps).replayFlow('sort');
    expect(vi.mocked(replayAndLearn)).toHaveBeenLastCalledWith(deps, { flowName: 'sort' });
  });
});
