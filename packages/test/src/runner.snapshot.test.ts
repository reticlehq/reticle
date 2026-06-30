import { afterEach, describe, expect, it } from 'vitest';
import { runSpecs } from './runner.js';
import { reticleTest } from './spec.js';
import { clearRegistry, getRegistered } from './registry.js';
import type { ToolInvoker } from '@reticle/server';
import type { RunnerOptions, SpecContext } from './types.js';

afterEach(() => clearRegistry());

const noopInvoke: ToolInvoker = () => Promise.resolve(undefined);
const buildContext = (invoke: ToolInvoker): SpecContext => ({ invoke });

function baseOptions(): RunnerOptions {
  return { invoke: noopInvoke, buildContext, now: () => 0 };
}

describe('runSpecs', () => {
  it('defaults to the module registry snapshot when specs omitted', async () => {
    reticleTest('first', () => undefined);
    reticleTest('second', () => undefined);
    const { results } = await runSpecs(baseOptions());
    expect(results.map((r) => r.name)).toEqual(['first', 'second']);
  });

  it('a spec that registers another spec mid-run does not mutate the active run', async () => {
    reticleTest('outer', () => {
      reticleTest('late', () => undefined);
    });
    const { results } = await runSpecs(baseOptions());
    expect(results.map((r) => r.name)).toEqual(['outer']);
    // The late registration landed in the registry, but not in this run.
    expect(getRegistered().map((s) => s.name)).toEqual(['outer', 'late']);
  });
});
