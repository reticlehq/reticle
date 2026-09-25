import { ConsequenceKind, EventType, redactUrl, type ReticleEvent } from '@reticlehq/core';
import { isDocumentInitiated } from '@reticlehq/engine/question/predicate/predicate-eval.js';
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

/**
 * Observed signals, store changes and REQUESTS the flow never declared — the side effects.
 *
 * Network was missing here for a long time, and it is the channel that carries the damage. An action
 * satisfying every consequence it declared and also firing a request nobody asked for came back with
 * an empty radius — which is the exact shape this idea exists for: a click that works AND posts
 * somewhere else. A signal and a store change stay inside the page; a request leaves the machine.
 *
 * Declared requests are matched by `urlContains`, the same rule the divergence walk uses, so a flow
 * that asked for `/api/order` is not told about `/api/order`.
 */
export function blastRadius(
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
  const declaredUrls = expected
    .filter(
      (l): l is Extract<ExpectedLink, { kind: typeof ConsequenceKind.NET }> =>
        ConsequenceKind.NET === l.kind,
    )
    .map((l) => l.urlContains);
  const radius: string[] = [];
  const add = (value: string): void => {
    if (!radius.includes(value)) radius.push(value);
  };
  for (const event of observed) {
    if (event.type === EventType.NET_REQUEST) {
      const url = event.data['url'];
      if ('string' !== typeof url) continue;
      if (declaredUrls.some((fragment) => url.includes(fragment))) continue;
      // A subresource the document fetched is the page loading, not a request the action sent: one
      // navigation is a couple of hundred of them. IPC and beacons carry an initiator too, and stay.
      if (isDocumentInitiated(event)) continue;
      const method = event.data['method'];
      add(`net ${'string' === typeof method ? method : 'request'} ${redactUrl(url)}`);
      continue;
    }
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

/**
 * The capsule as it travels on a verdict RESPONSE — without its causal summary.
 *
 * The same response already carries `summary`, computed by `causalSummary()` over the same window,
 * so shipping the capsule's copy sent the identical block twice. Measured on a 61-call drive of the
 * a 61-call drive, 9 of 9 capsules duplicated it exactly — **14% of the
 * whole run's token cost**, carrying nothing the reader did not already have two fields up.
 *
 * Wire-only. `capsule-store` persists the FULL capsule, because a stored capsule is read on its own
 * and a summary-less one would be unreadable.
 */
export function wireCapsule(capsule: DivergenceCapsule): Omit<DivergenceCapsule, 'summary'> {
  const { summary: _omitted, ...rest } = capsule;
  return rest;
}
