/**
 * Where a runtime value came from: state path ← the signal that preceded it ← the request behind it.
 *
 * The prior art this issue names (`firatorhan/sentinel`'s `get_lineage`) builds the same chain by
 * picking "the most recent action whose payload contains this value", then "an API call whose type
 * matches". That is CORRELATION, and for a devtool a human reads it is the right trade — the reader
 * discounts it on sight.
 *
 * Reticle's output is read by an agent that acts on it, so the same chain presented as fact is the
 * false-green shape this project exists to refuse. The join here is deliberately no cleverer than
 * theirs; what is different is that every link carries how much it is worth:
 *
 * - a state path that changed is OBSERVED — we have the event;
 * - "this signal caused it" is INFERRED, and the wording says so;
 * - several candidates are NAMED rather than narrowed to the most recent, because choosing is the
 *   one thing a correlation cannot justify;
 * - no candidate says the value was not seen to pass through one, and reaches for nothing.
 *
 * Read-only. Produces no verdict, is not reachable from an assert path, and changes nothing.
 */

import { EventType, type ReticleEvent } from '@reticlehq/core';
import { asString } from '@reticlehq/core';

/** What the caller is asking about. `value` narrows a path that changed more than once. */
export interface LineageQuery {
  path: string;
  value?: string;
}

/** One line of the chain, with the confidence that produced it. */
export interface LineageLink {
  /** Which stream this came from. */
  kind: 'state' | 'signal' | 'net';
  /** The rendered line, already carrying its own hedge. */
  text: string;
  /** True only when this is an event we hold. A join is never observed. */
  observed: boolean;
  /** Every candidate, when more than one could explain the link. Present only when ambiguous. */
  candidates?: string[];
}

export interface Lineage {
  /** False when the path was never seen to change — a different answer from an empty chain. */
  found: boolean;
  chain: LineageLink[];
  /** Why the chain stops where it does, when it stops early. */
  note?: string;
}

/**
 * How far back to look for a cause.
 *
 * Wide enough for a fetch → dispatch → render sequence, narrow enough that an unrelated signal a
 * page-load earlier cannot be offered as a candidate. Not a correctness bound: widening it produces
 * MORE named candidates, never a wrong single answer, because ambiguity is reported rather than
 * resolved.
 */
const CAUSE_WINDOW_MS = 5_000;

function stateChangesFor(events: readonly ReticleEvent[], query: LineageQuery): ReticleEvent[] {
  return events.filter((e) => {
    if (e.type !== EventType.STATE_CHANGE) return false;
    const path = asString(e.data['path']);
    if (path === undefined || !path.includes(query.path)) return false;
    if (query.value === undefined) return true;
    return String(e.data['value']) === query.value;
  });
}

/** Events of one kind inside the causal window before `t`, oldest first. */
function precursors(events: readonly ReticleEvent[], type: string, t: number): ReticleEvent[] {
  return events.filter((e) => e.type === type && e.t < t && e.t >= t - CAUSE_WINDOW_MS);
}

/**
 * Render an inferred link, hedged according to how many things could explain it.
 *
 * The wording IS the deliverable. `← USER_FETCH_SUCCESS` reads as fact; the two forms below read as
 * what they are, and a reader who skims still sees the hedge because it is in the first few words.
 */
function inferredLink(kind: 'signal' | 'net', labels: string[]): LineageLink {
  const one = labels[0] ?? '';
  if (1 === labels.length) {
    return { kind, text: `← likely ${one} (inferred from timing, 1 candidate)`, observed: false };
  }
  return {
    kind,
    text: `← ambiguous: ${String(labels.length)} candidates (${labels.join(', ')}) — not resolved, because timing alone cannot choose between them`,
    observed: false,
    candidates: labels,
  };
}

function signalLabel(e: ReticleEvent): string {
  return asString(e.data['name']) ?? '(unnamed signal)';
}

function netLabel(e: ReticleEvent): string {
  const method = asString(e.data['method']) ?? 'GET';
  const url = asString(e.data['url']) ?? '(unknown url)';
  const status = e.data['status'];
  return `${method} ${url}${'number' === typeof status ? ` (${String(status)})` : ''}`;
}

/**
 * The chain, most recent change first.
 *
 * Stops at the first link with nothing to point at, and says why. Walking past a gap would mean
 * joining across a hole in the evidence, which is exactly the step that turns a correlation into a
 * claim.
 */
export function traceLineage(events: readonly ReticleEvent[], query: LineageQuery): Lineage {
  const changes = stateChangesFor(events, query);
  const latest = changes[changes.length - 1];
  if (latest === undefined) {
    return {
      found: false,
      chain: [],
      note: `'${query.path}' was never seen to change in this window, so there is nothing to trace back from. It may be set before Reticle connected, or held somewhere no registered store exposes.`,
    };
  }

  const observedValue = String(latest.data['value']);
  const chain: LineageLink[] = [
    {
      kind: 'state',
      text: `${asString(latest.data['path']) ?? query.path} = ${observedValue}  (observed: state change at ${String(latest.t)}ms)`,
      observed: true,
    },
  ];

  const signals = precursors(events, EventType.SIGNAL, latest.t);
  if (0 === signals.length) {
    return {
      found: true,
      chain,
      note: 'No signal fired in the window before this change, so the value was not seen to pass through one. Nothing further is claimed — the change is real, its cause is not in evidence.',
    };
  }
  chain.push(inferredLink('signal', signals.map(signalLabel)));

  // Anchored on the OLDEST candidate signal: a request that preceded any of them could have produced
  // it, and narrowing to the newest would quietly discard candidates for the link below.
  const anchor = signals[0]?.t ?? latest.t;
  const calls = precursors(events, EventType.NET_REQUEST, anchor);
  if (0 === calls.length) {
    return {
      found: true,
      chain,
      note: 'No request preceded that signal in the window, so the chain stops there rather than joining across a gap in the evidence.',
    };
  }
  chain.push(inferredLink('net', calls.map(netLabel)));
  return { found: true, chain };
}
