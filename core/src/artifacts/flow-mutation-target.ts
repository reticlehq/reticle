/**
 * What to break in a flow, chosen from what the flow itself claims to depend on.
 *
 * This is the decision that makes a mutation score mean anything, and the single place it can
 * quietly stop meaning anything. Break an endpoint the flow never touches and the flow survives —
 * which reads as *"this test is worthless"* and is really *"we broke the wrong thing"*. A mutation
 * set that aims badly reports a suite full of bad tests and is itself the bug.
 *
 * A flow that declared a network consequence has already said what it depends on, in its own words,
 * at record time. That declaration is the target: break exactly what the flow claims to need, and a
 * flow that still passes has genuinely proved nothing about it.
 *
 * A flow that declared none yields NOTHING, and that is a finding rather than a gap to paper over.
 * Guessing a target would manufacture the demotion instead of measuring it.
 */

import type { FlowFile, FlowStep } from './flow-types.js';

/** Every endpoint this flow's own declarations name, in order, once each. */
export function mutationTargetsFor(flow: FlowFile): string[] {
  const targets: string[] = [];
  const add = (url: string | undefined): void => {
    if (url === undefined || '' === url) return;
    if (!targets.includes(url)) targets.push(url);
  };
  const walk = (steps: readonly FlowStep[]): void => {
    for (const step of steps) {
      add(step.expect?.net?.urlContains);
      // A sequence is where the real journeys live, so its children are where the real dependencies
      // are declared. A walk that stopped at the top level would find nothing in the common case.
      if (step.steps !== undefined) walk(step.steps);
    }
  };
  walk(flow.steps);
  add(flow.success?.net?.urlContains);
  return targets;
}
