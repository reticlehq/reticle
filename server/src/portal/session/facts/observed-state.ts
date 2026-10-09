import { BlindSpotKind, EventType, type ReticleEvent } from '@reticlehq/core';
import { ambientKeyOf, type AmbientCounts } from '@reticlehq/engine/window/ambient.js';

/**
 * The two things a session learns by watching its own event stream, as opposed to storing.
 *
 * Both are LEVELS derived from a stream, and both have to outlive the ring buffer — which is what
 * separates them from the buffer's job and earns them their own unit:
 *
 *   ambient    — which regions of the page move on their own (chat, tickers, live counters). Used by
 *                the settle oracle to ignore background motion, so an action isn't held open forever
 *                by churn it did not cause.
 *   blindSpots — how much of the page the SDK cannot observe (cross-origin frames, closed shadow
 *                roots). The SDK reports these only when the count CHANGES, so a page that mounts
 *                two frames at load announces them once and is silent forever after. Anything that
 *                infers coverage from a window of events therefore sees nothing and concludes the
 *                page was fully observed — a positive claim to have seen what we cannot see. Holding
 *                the level here makes coverage something to ask rather than infer.
 */
/** The resolution rate-limit drops are kept at: per second of session time. */
const RATE_DROP_BUCKET_MS = 1000;
/** An hour of seconds; older buckets are past any window a verdict reads. */
const MAX_RATE_DROP_BUCKETS = 3600;

export class ObservedState {
  /** What THIS session observed. Never contains seeded history — see seedAmbient. */
  readonly #ownAmbient: AmbientCounts = {};
  /** What previous sessions learned, kept separate so it is never re-persisted as if newly seen. */
  #seededAmbient: AmbientCounts = {};
  readonly #blindSpots: Record<string, number> = {};
  /** Bridge-side sampling, by second of session time. See noteRateLimited. */
  readonly #rateDrops: { at: number; count: number }[] = [];

  /** Fold one already-attributed event into the learned state. */
  observe(event: ReticleEvent): void {
    // Only UNATTRIBUTED events count as ambient: an event caused by an action is the action's work,
    // and learning it as background would teach the settle oracle to ignore real effects.
    if (event.actionId === undefined) {
      const key = ambientKeyOf(event);
      if (key !== undefined) this.#ownAmbient[key] = (this.#ownAmbient[key] ?? 0) + 1;
    }
    if (event.type === EventType.BLIND_SPOT) {
      const kind = event.data['kind'];
      const count = event.data['count'];
      if ('string' === typeof kind && 'number' === typeof count) this.#blindSpots[kind] = count;
    }
  }

  /**
   * Learned ambient-churn counts — seeded history PLUS this session — for the settle oracle, which
   * wants the sharpest available picture of what moves on its own.
   */
  ambientCounts(): AmbientCounts {
    const merged: AmbientCounts = { ...this.#seededAmbient };
    for (const [key, count] of Object.entries(this.#ownAmbient)) {
      merged[key] = (merged[key] ?? 0) + count;
    }
    return merged;
  }

  /**
   * ONLY what this session observed — the correct input to persistence.
   *
   * Teardown accumulates by adding the session's counts onto the file it loaded. When the session's
   * counts still contained the seeded ones, that addition wrote `2 x persisted + own` every run, so
   * the map doubled per session: the file committed in this repo had reached ~9.1e23 (about 2^80,
   * i.e. ~80 sessions of doubling). Keeping the seed separate makes the accumulation what it always
   * claimed to be — history plus what is new.
   */
  ownAmbientCounts(): AmbientCounts {
    return this.#ownAmbient;
  }

  /**
   * Seed from the persisted per-app map so the picture sharpens across sessions.
   * In-session counts win: they describe this page as it is now.
   */
  seedAmbient(counts: AmbientCounts): void {
    this.#seededAmbient = { ...counts };
  }

  /** Latest reported count per blind-spot kind, for the whole session. */
  /**
   * Refs the agent has driven, for the exercised/untouched split `reticle_coverage` reports.
   *
   * Kept here beside the blind-spot counts because both are per-session observed facts that must
   * SURVIVE buffer eviction. Deriving "what did I touch" from the event buffer instead would mean an
   * action fifty steps ago silently stops counting, so "untouched" would quietly come to mean
   * "recently untouched" — a number that reads as thorough while drifting toward the opposite.
   */
  readonly #actedRefs = new Set<string>();
  /**
   * The same drives, keyed by something that SURVIVES a re-render.
   *
   * A ref is invalidated whenever the DOM changes, so on a framework that replaces nodes rather than
   * reconciling in place (Next's app router, for one) every driven ref is stale by the time coverage
   * is asked and the number reads 0 forever. The snapshot label — `button "Deploy"` — names the same
   * control on both sides of a re-render.
   */
  readonly #actedLabels = new Set<string>();

  /** Record a driven ref. Idempotent. */
  recordActedRef(ref: string): void {
    if (ref.length > 0) this.#actedRefs.add(ref);
  }

  /** Record a driven control's re-render-surviving label. Idempotent; empty labels are not identities. */
  recordActedLabel(label: string): void {
    if (label.length > 0) this.#actedLabels.add(label);
  }

  /** Every ref driven so far this session. */
  actedRefs(): ReadonlySet<string> {
    return this.#actedRefs;
  }

  /** Every driven control's label, for matching across re-renders. */
  actedLabels(): ReadonlySet<string> {
    return this.#actedLabels;
  }

  /**
   * Controls whose action came back `verified: "yes"` on a declared consequence — the PROVED level
   * of the coverage ledger. Same label identity as `actedLabels`, so the two compare directly.
   */
  readonly #provedLabels = new Set<string>();

  recordProvedLabel(label: string): void {
    if (label.length > 0) this.#provedLabels.add(label);
  }

  provedLabels(): ReadonlySet<string> {
    return this.#provedLabels;
  }

  /**
   * Record bridge-side sampling as a blind spot.
   *
   * Every other blind spot is reported BY the SDK, which cannot report this one: the events were
   * dropped before they reached the observer. Recording it here keeps the honesty contract intact —
   * a verdict over a sampled window says `coverage: partial` rather than implying it saw everything.
   */
  noteRateLimited(dropped: number, at?: number): void {
    const before = this.#blindSpots[BlindSpotKind.RATE_LIMITED] ?? 0;
    this.#blindSpots[BlindSpotKind.RATE_LIMITED] = dropped;
    // WHEN, beside how many: the running total above is a fact about the session, and read as one
    // it made every verdict after a single burst `unclean_capture`, however quiet its own window
    // was (#1414). Bucketed per second so a sustained flood stays a bounded list.
    if (at === undefined || dropped <= before) return;
    const second = Math.floor(at / RATE_DROP_BUCKET_MS) * RATE_DROP_BUCKET_MS;
    const last = this.#rateDrops[this.#rateDrops.length - 1];
    if (last !== undefined && last.at === second) last.count += dropped - before;
    else this.#rateDrops.push({ at: second, count: dropped - before });
    if (this.#rateDrops.length > MAX_RATE_DROP_BUCKETS) this.#rateDrops.shift();
  }

  /**
   * How many events the bridge sampled away at or after `since` (session-elapsed ms).
   *
   * A bucket is counted when any part of its second reaches the window, so a drop in the same
   * second as the window's start still impeaches it: erring toward unclean is the safe direction.
   */
  rateDroppedSince(since: number): number {
    let total = 0;
    for (const bucket of this.#rateDrops) {
      if (bucket.at + RATE_DROP_BUCKET_MS > since) total += bucket.count;
    }
    return total;
  }

  /**
   * The blind spots, session-wide; or, given `since`, with bridge sampling counted only from then on.
   *
   * Coverage reads the session-wide view: that sampling happened at all is a fact about the session.
   * A verdict deciding whether ITS capture is clean reads the windowed one. Read session-wide there,
   * one early burst made every later verdict on the tab `unclean_capture` (#1414).
   */
  blindSpots(since?: number): Readonly<Record<string, number>> {
    if (since === undefined) return this.#blindSpots;
    return { ...this.#blindSpots, [BlindSpotKind.RATE_LIMITED]: this.rateDroppedSince(since) };
  }
}

/**
 * The snapshot-shaped labels an act reply names its control by: the testid, and `role "name"`.
 *
 * The TESTID first: it is the strongest identity a control has and it survives any re-render.
 * Coverage previously matched only on `role "name"`, so a control with a testid but no accessible
 * name — or on a stack where the act reply carried neither — was unrecognisable after a re-render,
 * and coverage read `exercised: 0` however much work had been done.
 */
export function controlLabelsOf(payload: unknown): string[] {
  if (typeof payload !== 'object' || null === payload) return [];
  const record = payload as Record<string, unknown>;
  const labels: string[] = [];
  const testid = record['testid'];
  if ('string' === typeof testid && testid.length > 0) labels.push(testid);
  const role = record['role'];
  const name = record['name'];
  if ('string' === typeof role && 'string' === typeof name && role.length > 0 && name.length > 0)
    labels.push(`${role} "${name}"`);
  return labels;
}
