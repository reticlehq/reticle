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
 * One more source, read rather than recomputed: the SDK stamps `actionId` + `attribution` onto every
 * event observed while a driven action is active (see `core/messages.ts`). That is a time-window
 * heuristic too — `EventAttribution.WINDOW`'s own comment says so — but it is the same tier, already
 * computed, already labelled, and narrower than a fresh look-back, so the join reads it two ways:
 * a candidate stamped with a DIFFERENT act is not a candidate for this one (the stamp rules out; it
 * never rules in), and a stamped change with no signal behind it names the act rather than calling
 * its cause "not in evidence" when the evidence is on the event (#939).
 *
 * Read-only. Produces no verdict, is not reachable from an assert path, and changes nothing.
 */

import { EventAttribution, EventType, type ReticleEvent } from '@reticlehq/core';
import { asString } from '../tools/tools-helpers.js';

/** What the caller is asking about. `value` narrows a path that changed more than once. */
export interface LineageQuery {
  path: string;
  value?: string;
}

/** One line of the chain, with the confidence that produced it. */
export interface LineageLink {
  /** Which stream this came from. `act` is the driven action the event was stamped with. */
  kind: 'state' | 'act' | 'signal' | 'net';
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

/**
 * Events of one kind inside the causal window before `t`, oldest first.
 *
 * When the change being traced carries an `actionId`, a candidate stamped with a DIFFERENT one is
 * dropped: the SDK observed it under another driven action, and five seconds spans several of
 * those. An UNSTAMPED candidate stays. A request fired just before dispatch carries no stamp and its
 * response can still land inside the act — the stamp proves an event belongs elsewhere, it cannot
 * prove an unstamped one is unrelated. Rules out, never rules in.
 */
function precursors(
  events: readonly ReticleEvent[],
  type: string,
  t: number,
  actionId: string | undefined,
): ReticleEvent[] {
  return events.filter(
    (e) =>
      e.type === type &&
      e.t < t &&
      e.t >= t - CAUSE_WINDOW_MS &&
      (actionId === undefined || e.actionId === undefined || e.actionId === actionId),
  );
}

/**
 * The link from a stamped change to the act that was active when it was observed.
 *
 * Rendered from the tier the event carries, not asserted: `attribution` is present iff `actionId`
 * is, and today there is one tier. It is not an observation — the SDK stamped an id across a span
 * of time — and the text says what that span is, so a reader who acts on the arrow has been told
 * what the arrow is worth.
 */
function actLink(actionId: string, attribution: string | undefined): LineageLink {
  const tier = attribution ?? EventAttribution.WINDOW;
  return {
    kind: 'act',
    text: `← attributed to action ${actionId} — ${tier} tier: the SDK stamped this action's id on every event between its dispatch and settle. A time window, not dataflow.`,
    observed: false,
  };
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

  const actionId = latest.actionId;
  const signals = precursors(events, EventType.SIGNAL, latest.t, actionId);
  if (0 === signals.length) {
    if (actionId === undefined) {
      return {
        found: true,
        chain,
        note: 'No signal fired in the window before this change, so the value was not seen to pass through one. Nothing further is claimed — the change is real, its cause is not in evidence.',
      };
    }
    // The common case: `reticle.signal()` is a call the APP must make, and most apps never do. But
    // this change was observed under a driven action, and that is on the event. Saying its cause is
    // "not in evidence" would be a factual claim, and a false one.
    chain.push(actLink(actionId, latest.attribution));
    const driven = precursors(events, EventType.NET_REQUEST, latest.t, actionId);
    if (0 === driven.length) {
      return {
        found: true,
        chain,
        note: 'No signal fired, and no request in the window carries this action or none at all, so the chain stops at the act rather than joining across a gap in the evidence.',
      };
    }
    chain.push(inferredLink('net', driven.map(netLabel)));
    return { found: true, chain };
  }
  chain.push(inferredLink('signal', signals.map(signalLabel)));

  // Anchored on the OLDEST candidate signal: a request that preceded any of them could have produced
  // it, and narrowing to the newest would quietly discard candidates for the link below.
  const anchor = signals[0]?.t ?? latest.t;
  const calls = precursors(events, EventType.NET_REQUEST, anchor, actionId);
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
