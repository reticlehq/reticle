import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { FLOW_TOOLS } from './flow-tools.js';

/**
 * A regression this flow detected reaches the agent that asked.
 *
 * An undeclared output field is STRIPPED from a validating profile's response. So `learned`,
 * `promoted` and `regressed` were computed, written to disk, and then dropped on the way out: a
 * guarded defect could come back, the flow could notice, and the caller would be handed
 * `status: "ok"` with nothing naming the regression. The feature's entire stated payoff —
 * "its return is a regression this flow reports by itself" — was unobservable.
 *
 * This file exists because the same defect already happened once in the same schema, to `name`,
 * with a comment above it saying so: "omitted here, so a validating profile stripped it and a
 * replay result arrived anonymous." A guard belongs where a mistake has been made twice.
 */
const replayTool = (): (typeof FLOW_TOOLS)[number] => {
  const tool = FLOW_TOOLS.find((t) => t.name === ReticleTool.FLOW_REPLAY);
  if (tool === undefined) throw new Error('reticle_flow_replay is not on the surface');
  return tool;
};

describe('reticle_flow_replay declares what it learned', () => {
  it('declares every field the learning layer produces', () => {
    const declared = Object.keys(replayTool().outputSchema ?? {});
    for (const field of ['learned', 'promoted', 'regressed']) {
      expect(declared, `${field} is computed but undeclared, so it is stripped`).toContain(field);
    }
  });

  it('still declares the fields a caller already depended on', () => {
    // Widening a schema must not shuffle it: these are the ones whose absence has bitten before.
    const declared = Object.keys(replayTool().outputSchema ?? {});
    for (const field of ['name', 'status', 'steps']) {
      expect(declared).toContain(field);
    }
  });
});
