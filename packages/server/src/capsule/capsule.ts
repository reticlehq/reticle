import { ConsequenceKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { causalSummary, type CausalSummary } from './causal-summary.js';
import { firstDivergence, type Divergence, type ExpectedLink } from './divergence.js';

/**
 * The divergence capsule (Tier 2) — the whole packet on a red: the attributed causal summary, the
 * FIRST divergence (where declared ≠ observed), and the BLAST RADIUS (truth that changed OUTSIDE the
 * declared consequence — an act that also fired an undeclared signal or mutated an unexpected store).
 * Blast radius is how a "green" that did extra damage still gets caught. Pure composition of the parts;
 * the paste-ready repair packet and wiring onto red results build on this.
 */

export interface DivergenceCapsule {
  summary: CausalSummary;
  firstDivergence: Divergence | null;
  /** Observed consequences not in the declared set — unexpected side effects. */
  blastRadius: string[];
}

/** Observed signal/state changes the flow never declared — the side effects. */
function blastRadius(
  expected: readonly ExpectedLink[],
  observed: readonly ReticleEvent[],
): string[] {
  const declaredSignals = new Set(
    expected
      .filter(
        (l): l is Extract<ExpectedLink, { kind: typeof ConsequenceKind.SIGNAL }> =>
          ConsequenceKind.SIGNAL === l.kind,
      )
      .map((l) => l.name),
  );
  const declaredStates = new Set(
    expected
      .filter(
        (l): l is Extract<ExpectedLink, { kind: typeof ConsequenceKind.STATE }> =>
          ConsequenceKind.STATE === l.kind,
      )
      .map((l) => l.name),
  );
  const radius: string[] = [];
  const add = (value: string): void => {
    if (!radius.includes(value)) radius.push(value);
  };
  for (const event of observed) {
    const name = event.data['name'];
    if (typeof name !== 'string') continue;
    if (event.type === EventType.SIGNAL && !declaredSignals.has(name)) add(`signal ${name}`);
    if (event.type === EventType.STATE_CHANGE && !declaredStates.has(name)) add(`state ${name}`);
  }
  return radius;
}

/** Compose the full capsule from the declared chain and the observed (attributed) event window. */
export function buildDivergenceCapsule(
  expected: readonly ExpectedLink[],
  observed: readonly ReticleEvent[],
  truncated = false,
): DivergenceCapsule {
  return {
    summary: causalSummary(observed, { truncated }),
    firstDivergence: firstDivergence(expected, observed, truncated),
    blastRadius: blastRadius(expected, observed),
  };
}
