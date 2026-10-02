import { afterEach, describe, expect, it } from 'vitest';
import { runSpecs } from './runner.js';
import { reticleTest } from './spec.js';
import { clearRegistry, getRegistered } from './registry.js';
import type { ToolInvoker } from '@reticlehq/server';
import type { RunnerOptions, SpecContext } from './types.js';

afterEach(() => clearRegistry());

const noopInvoke: ToolInvoker = () => Promise.resolve(undefined);
// The runner passes `t` straight through to the spec body and never reads a matcher off it, so
// these tests hand it the one field they exercise. The cast is the assertion: if the runner ever
// starts touching a matcher, this stub stops being honest and the test that relies on it should
// break rather than quietly work.
const buildContext = (invoke: ToolInvoker): SpecContext => ({ invoke }) as SpecContext;

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
