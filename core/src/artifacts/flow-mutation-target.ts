/**
 * What a flow DECLARED it depends on, and the two things worth doing with that.
 *
 * Both live here because both answer the same question first — which endpoints did this flow name
 * in its own words, at record time — and then diverge only in what they do next: break one
 * (mutation), or slow them all by different amounts (perturbation). Splitting them would let two
 * files drift about what "declared" means, which is the one thing neither can afford.
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

/** The shape a network mock needs from us: which endpoint, and how much later. Nothing else. */
export interface Perturbation {
  urlContains: string;
  delayMs: number;
}

/**
 * The widest delay injected, in ms.
 *
 * Big enough that a later request can beat an earlier one home — that is the whole mechanism — and
 * small enough to stay under an ordinary settle budget, so a perturbed replay still finishes rather
 * than timing out and reporting a stall it caused itself.
 */
const MAX_DELAY_MS = 400;

/** The narrowest non-zero delay. Below this the scheduler noise IS the perturbation. */
const MIN_DELAY_MS = 40;

/**
 * mulberry32 — small, fast, and famously well-distributed for a 32-bit seed.
 *
 * Written out rather than imported because the only thing that matters is that it never changes:
 * a seed's meaning is a promise to whoever recorded a repro against it, and a dependency bump that
 * silently reshuffled the sequence would break every one of them without a test going red.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Which endpoints to slow, and by how much, for this seed.
 *
 * Every endpoint the flow DECLARED it depends on gets its own delay, drawn independently, so the
 * spread is what reorders them. One uniform delay would slow everything equally and race nothing —
 * the app would see the same order it always sees, just later.
 *
 * `targets` comes from what the flow itself declared (`mutationTargetsFor`), so chaos is applied to
 * the endpoints the flow claims to care about rather than to traffic it never mentioned.
 */
export function perturbationFor(seed: number, targets: readonly string[]): Perturbation[] {
  if (0 === targets.length) return [];
  const rand = mulberry32(seed);
  const span = MAX_DELAY_MS - MIN_DELAY_MS;
  return targets.map((urlContains) => ({
    urlContains,
    delayMs: MIN_DELAY_MS + Math.floor(rand() * span),
  }));
}
