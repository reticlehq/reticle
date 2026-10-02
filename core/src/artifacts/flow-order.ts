/**
 * The order a suite runs its flows in, from what each one declares it needs.
 *
 * "Checkout" assumes a signed-in user. Run it first and it fails for a reason that has nothing to do
 * with checkout, which costs somebody a debugging session on working code. Directory order is not an
 * answer to that — it is alphabetical luck.
 *
 * A FOLD, not a scheduler. It says what must come before what; a cycle or a missing prerequisite is
 * REPORTED, never resolved. Inventing an order for a contradictory declaration would produce a suite
 * that runs in an order nobody asked for and cannot be reasoned about when it fails — and a flow
 * whose prerequisite is absent is not "run it anyway", it is a question nobody has answered.
 *
 * Stable among independents: declaration order is preserved, because a suite whose order shuffles
 * between runs makes a flaky flow impossible to attribute — what ran before it changed too.
 *
 * Pure: flows in, an order and its problems out.
 */

import type { FlowFile } from './flow-types.js';

export interface OrderedFlows {
  /** What to run, prerequisites first. */
  run: FlowFile[];
  /** Flows caught in a dependency cycle. None of them run. */
  cycles: string[];
  /** A flow that needs something not in this run, named with what it wanted. */
  unsatisfied: { flow: string; needs: string }[];
}

export function orderFlows(flows: readonly FlowFile[]): OrderedFlows {
  const present = new Map(flows.map((flow) => [flow.name, flow]));
  const unsatisfied: { flow: string; needs: string }[] = [];
  for (const flow of flows) {
    for (const need of flow.needs ?? []) {
      if (!present.has(need)) unsatisfied.push({ flow: flow.name, needs: need });
    }
  }
  const blocked = new Set(unsatisfied.map((entry) => entry.flow));

  const run: FlowFile[] = [];
  const done = new Set<string>();
  const cycles = new Set<string>();
  // Repeated passes rather than a recursive walk: a pass that places nothing means every remaining
  // flow is waiting on another that is also waiting, which IS the cycle — found without having to
  // track a traversal stack.
  let remaining = flows.filter((flow) => !blocked.has(flow.name));
  while (remaining.length > 0) {
    const ready = remaining.filter((flow) =>
      (flow.needs ?? []).every((need) => done.has(need) || !present.has(need)),
    );
    if (0 === ready.length) {
      for (const flow of remaining) cycles.add(flow.name);
      break;
    }
    for (const flow of ready) {
      run.push(flow);
      done.add(flow.name);
    }
    remaining = remaining.filter((flow) => !done.has(flow.name));
  }

  return { run, cycles: [...cycles].sort(), unsatisfied };
}
