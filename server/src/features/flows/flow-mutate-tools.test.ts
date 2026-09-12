import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { FLOW_MUTATE_TOOL } from './flow-mutate-tools.js';
import type { ToolDeps } from '../../agent/tools/tools.js';

/**
 * Asking a flow the only question that grades IT rather than the app.
 *
 * Everything this needs was built and tested apart: choose the target from what the flow declared,
 * run replay/break/replay with a guaranteed reversal, grade it with the three refusals that keep the
 * number honest. This is the call.
 *
 * What is pinned here is the two ways it must answer NOTHING rather than a number. Both are cases
 * where a result would be worse than an absence — a mutation score that reports a demotion it did
 * not measure is a number that argues for deleting good tests.
 */

const deps = (over: Partial<ToolDeps> = {}): ToolDeps =>
  ({ sessions: { resolve: () => undefined }, ...over }) as unknown as ToolDeps;

describe('the flow-mutation tool', () => {
  it('is the action reticle_verify exposes, not a nineteenth tool', () => {
    expect(FLOW_MUTATE_TOOL.name).toBe(ReticleTool.FLOW_MUTATE);
  });

  it('refuses a flow that declared nothing to break, and says what would fix it', async () => {
    // Not a failure to measure: the flow never claimed to depend on a request, so there is nothing
    // whose breakage it could be expected to notice. Breaking something arbitrary would manufacture
    // a demotion — a number arguing to delete a test for surviving a break that was never aimed at it.
    const result = (await FLOW_MUTATE_TOOL.handler(
      deps({
        flows: {
          load: () =>
            Promise.resolve({
              ok: true,
              value: { version: 1, name: 'f', createdAt: 0, steps: [] },
            }),
        },
      } as unknown as Partial<ToolDeps>),
      { flowName: 'f' },
    )) as { outcome?: string; because?: string };
    expect(result.outcome).toBeUndefined();
    expect(result.because).toMatch(/declare|net|depends/i);
  });

  it('refuses when no driven browser can break anything, and says so', async () => {
    // An attached tab cannot be perturbed. Reporting "survived" here would demote every flow on
    // every project that has not run `reticle drive`.
    const result = (await FLOW_MUTATE_TOOL.handler(
      deps({
        realInput: undefined,
        flows: {
          load: () =>
            Promise.resolve({
              ok: true,
              value: {
                version: 1,
                name: 'f',
                createdAt: 0,
                steps: [{ tool: 'act', args: {}, expect: { net: { urlContains: '/api/o' } } }],
              },
            }),
        },
      } as unknown as Partial<ToolDeps>),
      { flowName: 'f' },
    )) as { outcome?: string; because?: string };
    expect(result.outcome).toBeUndefined();
    expect(result.because).toMatch(/driven|drive/i);
  });
});
