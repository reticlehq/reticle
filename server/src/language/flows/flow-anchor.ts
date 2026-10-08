import {
  AnchorKind,
  DriftReason,
  ReticleCommand,
  QueryBy,
  asRecord,
  asString,
  type CommandResult,
  type Drift,
  type FlowAnchor,
  type QueryEmptyHint,
} from '@reticlehq/core';
import { queryRefs } from './replay.js';
import type { FlowReplaySession, Sleep } from './flow-replay-types.js';

/**
 * Finding a step's anchor again, and saying legibly why it could not be found.
 *
 * Split out of `flow-replay.ts` because `flow-step-runners.ts` needs six of these and had to import
 * them back out of the module that imports IT — a real runtime cycle, not a type-erased one. These
 * functions know nothing about running a step; they resolve a locator and describe a miss, which is
 * why they can sit underneath both.
 */

/**
 * A single ASCII-ish edit distance (case-insensitive). Small inputs (testids), so O(n*m) is fine.
 * Exported so the heal proposal layer derives its confidence from the SAME distance used to
 * pick `nearest` — no second, divergent heuristic enters the trust boundary.
 */
export function editDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const rows = s.length + 1;
  const cols = t.length + 1;
  const prev = new Array<number>(cols);
  const curr = new Array<number>(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;
  for (let i = 1; i < rows; i++) {
    curr[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j < cols; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[cols - 1] ?? 0;
}

/**
 * The closest present testid to a missing one, by case-insensitive edit distance, ties broken
 * by shortest length then lexically. Returns null only when nothing is present — so a drift
 * record always names a fix when one exists ("whose fault is it": here is the closest survivor).
 */
export function nearestTestid(missing: string, present: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of present) {
    const distance = editDistance(missing, candidate);
    if (
      distance < bestDistance ||
      (distance === bestDistance && best !== null && candidate.length < best.length) ||
      (distance === bestDistance &&
        best !== null &&
        candidate.length === best.length &&
        candidate < best)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Bounded settle for anchor re-resolution. A testid step queries the live DOM for the anchor; if a
 * render is still in flight (post-login route swap, modal mount, list paint) the element exists but
 * isn't painted yet, and a single QUERY would read zero and FALSELY drift. We re-query a few times
 * with a short delay before concluding the anchor is gone — a real regression (renamed/removed
 * testid) stays missing across every attempt, so this removes flakiness without masking breaks.
 */
const ANCHOR_SETTLE_ATTEMPTS = 8;
const ANCHOR_SETTLE_DELAY_MS = 150;
/**
 * The budget that actually governs, in wall-clock milliseconds.
 *
 * Attempts were the bound, and on an event-chatty page that collapsed. `settleTick` ends on EITHER
 * an event OR the tick, so a page emitting continuously (API calls, a large form render, CSS
 * transition start/end pairs) burned all eight attempts in **224–758ms measured** — a budget
 * documented as 1.2s, spent in a fifth of it, before a newly routed page had mounted its controls.
 * Cross-route replays drifted `testid_not_found` at 278ms while the same flow passed on a quiet page.
 *
 * An event arriving is evidence the page is still working. It should EXTEND the wait, not spend it.
 * So the deadline decides when to give up, and the attempt cap below survives only as a backstop
 * against a pathological storm spinning this loop hot.
 */
const ANCHOR_SETTLE_BUDGET_MS = ANCHOR_SETTLE_ATTEMPTS * ANCHOR_SETTLE_DELAY_MS;
/** Backstop only. Generous on purpose: the deadline is the real bound, this just prevents a spin. */
const ANCHOR_SETTLE_MAX_ATTEMPTS = 40;
/** Extract the live element refs + the zero-match near-miss hint from a QUERY command result. */
function readQuery(result: CommandResult): { refs: string[]; hint?: QueryEmptyHint } {
  const refs = queryRefs(result);
  if (!result.ok) return { refs };
  const payload = asRecord(result.result);
  const rawHint = payload['hint'];
  if ('object' === typeof rawHint && rawHint !== null) {
    const hint = asRecord(rawHint);
    const present = Array.isArray(hint['presentTestids'])
      ? hint['presentTestids'].filter((t): t is string => 'string' === typeof t)
      : [];
    return {
      refs,
      hint: {
        route: asString(hint['route']) ?? '',
        presentTestids: present,
        presentRegions: [],
        knownEmptyState: true === hint['knownEmptyState'],
      },
    };
  }
  return { refs };
}

/**
 * True when ≥2 present testids tie at the minimum edit distance to the missing one — `nearest` is
 * then an arbitrary lexical-tiebreak pick, so auto-healing would be a coin-flip between candidates.
 * Such a drift is surfaced (with a nearest) but never auto-healed.
 */
export function nearestIsAmbiguous(missing: string, present: string[]): boolean {
  if (present.length < 2) return false;
  let min = Number.POSITIVE_INFINITY;
  let count = 0;
  for (const candidate of present) {
    const distance = editDistance(missing, candidate);
    if (distance < min) {
      min = distance;
      count = 1;
    } else if (distance === min) {
      count += 1;
    }
  }
  return count >= 2;
}

/** Build the legible-drift record for a testid anchor that resolved to zero live elements. */
export function testidDrift(value: string, hint: QueryEmptyHint | undefined): Drift {
  const present = hint?.presentTestids ?? [];
  const drift: Drift = {
    reasonKind: DriftReason.TESTID_NOT_FOUND,
    reason: `testid "${value}" not found`,
    anchor: value,
    nearest: nearestTestid(value, present),
  };
  if (nearestIsAmbiguous(value, present)) drift.ambiguous = true;
  return drift;
}

/**
 * How an anchor is ADDRESSED — the sentence that names it, and the label a result row carries.
 *
 * Two different strings, and neither can be derived from the other: `value` is a raw testid for one
 * anchor kind and a human-readable label for the others, so one sentence cannot name both. Calling a
 * role anchor `testid "button "View result""` sends the reader to edit a locator that does not exist
 * on that step, which is the same misdirection the drift reason exists to remove.
 *
 * Derived from the anchor rather than passed in by the caller. The first version of the role fix took
 * a `described` argument and wrote `ambiguousAnchorDrift(label, n, \`role anchor ${label}\`)` — the
 * same string twice, so the `anchor` field and the sentence could drift apart with nothing to catch
 * it, and the next anchor kind would have had to remember the convention on its own.
 */
function anchorAddress(anchor: FlowAnchor): { described: string; label: string } {
  if (anchor.kind === AnchorKind.TESTID) {
    return { described: `testid "${anchor.value}"`, label: anchor.value };
  }
  if (anchor.kind === AnchorKind.ROLE) {
    // Kind named explicitly: `button "View result"` alone reads as a testid that happens to contain
    // a space, and the reader would go looking for a locator nothing on the step declares.
    const label = `${anchor.role} "${String(anchor.name)}"`;
    return { described: `role anchor ${label}`, label };
  }
  // A component needs no such qualifier: `componentLabel` already answers
  // `NewDeployButton@Deployments.tsx:107`, which no reader mistakes for a testid.
  const label = anchor.kind === AnchorKind.COMPONENT ? componentLabel(anchor) : anchorLabel(anchor);
  return { described: `anchor ${label}`, label };
}

/**
 * What the stale-ref retry found when it ran the locator again.
 *
 * A discriminated result rather than the bare `string | undefined` this started as, because the two
 * ways of getting no ref back are different answers and were arriving as one. `{ drift }` says the
 * locator now names SEVERAL elements — the re-render turned an unambiguous anchor into an ambiguous
 * one, and the fix is a NARROWER anchor. `undefined` says it named none, or named one and the second
 * dispatch failed too; both of those are already told truthfully by the stale-ref error the first
 * attempt produced, so there is nothing to add.
 *
 * Collapsed together, the ambiguous case was reported as "ref 'e-orig' no longer resolves to an
 * element" — a sentence about an element that is GONE, sent for an element that is now three. An
 * agent reading it hunts for a rename or re-records the flow; the truth is that the anchor needs
 * narrowing, which is the whole reason `ANCHOR_AMBIGUOUS` exists as its own reason kind.
 */
export type Reresolved = { readonly ref: string } | { readonly drift: Drift };

/**
 * Build the drift for a step whose anchor matched MORE THAN ONE live element.
 *
 * `ambiguous: true` is set because that is exactly what it is, and it is the field heal already
 * reads to refuse an auto-rebind -- an ambiguous drift must never be healed to an arbitrary pick,
 * which is the same reasoning that made this a drift instead of a note in the first place.
 *
 * `nearest` is null on purpose. There is no nearest: the anchor was found, several times over, and
 * proposing one of the matches as "the" match would re-make the guess this reason exists to stop.
 * The fix is a NARROWER anchor, and only a human or an agent looking at the page can choose it.
 *
 * Private: callers reach it through `ambiguityDrift`, which is the RULE rather than the record.
 * Exported, it had three call sites and a fourth anchor kind that never called it at all.
 */
function ambiguousAnchorDrift(anchor: FlowAnchor, matches: number): Drift {
  const { described, label } = anchorAddress(anchor);
  return {
    reasonKind: DriftReason.ANCHOR_AMBIGUOUS,
    reason: `${described} matched ${String(matches)} live elements — which one the recording meant is not decidable; anchor this step to something unique`,
    anchor: label,
    nearest: null,
    ambiguous: true,
  };
}

/**
 * The ambiguity rule itself: an anchor that matched several live elements is DRIFT, never a guess.
 *
 * Returns null when the locator named zero or one element, so a runner reads it as
 * `const drift = ambiguityDrift(anchor, refs); if (drift !== null) return { …, ok: false, drift };`
 * and never has to reconstruct the record itself.
 *
 * ONE function, because three anchor kinds ask the same question and each used to answer for itself.
 * testid was fixed first and role second, and role's fix was written as a copy of testid's — so "is
 * this ambiguous" had two answers and COMPONENT had none at all. `runComponentStep` took `refs[0]`,
 * dispatched and returned `ok: true` whenever `by:'component'` matched several elements, which is the
 * ordinary case for a component rendered once per row (a table row's action button). The verdict
 * reads `drift` and `ok` and nothing else, so that green was indistinguishable from a replay that did
 * what it did before — the #1227 defect, one anchor kind over.
 *
 * The caller must not dispatch before checking. Acting and then reporting drift would leave the app
 * changed by a click nobody can attribute, which is worse than the ambiguity it reports.
 */
export function ambiguityDrift(anchor: FlowAnchor, refs: readonly string[]): Drift | null {
  return refs.length > 1 && refFor(anchor, refs) === undefined
    ? ambiguousAnchorDrift(anchor, refs.length)
    : null;
}

/**
 * The one ref a step means: the only match, or the recorded position among same-named controls
 * while the page still has exactly as many of them as when it was recorded. Otherwise undefined.
 */
export function refFor(anchor: object, refs: readonly string[]): string | undefined {
  if (1 === refs.length) return refs[0];
  const { nth, of }: Record<string, unknown> = { ...anchor };
  return 'number' === typeof nth && of === refs.length ? refs[nth] : undefined;
}

/**
 * The anchor as the stale-ref RETRY found it: one ref to dispatch at, an ambiguity to report, or
 * neither.
 *
 * The same rule as `ambiguityDrift`, one layer deeper, and shared for the same reason: a re-render
 * can turn an unambiguous anchor into an ambiguous one between the two dispatches, and dispatching
 * at the first of the new matches would re-make the guess the caller's own check exists to refuse —
 * in a place the caller cannot see. Written once so the three runners cannot answer it differently,
 * which is how the component runner came to have no answer at all.
 *
 * `refs[0]` is read only after `ambiguityDrift` has cleared the several-match case, so the only way
 * it is undefined here is zero matches.
 */
export function reresolved(anchor: FlowAnchor, refs: readonly string[]): Reresolved | undefined {
  const drift = ambiguityDrift(anchor, refs);
  if (drift !== null) return { drift };
  const ref = refFor(anchor, refs);
  return ref === undefined ? undefined : { ref };
}

/**
 * Build the drift for a step whose `expect.element` testid was absent after the action ran.
 *
 * Deliberately not `testidDrift`: that one means "this step's anchor is gone", and reusing it here
 * put the assertion's target in the result's `anchor` field — the field documented as the value the
 * step is bound to. A caller then reads `testid_not_found` naming something that was never the
 * step's locator and goes hunting for a rename, while the truth is the step ran and its
 * consequence did not hold.
 */
export function expectElementDrift(value: string, hint: QueryEmptyHint | undefined): Drift {
  const present = hint?.presentTestids ?? [];
  const drift: Drift = {
    reasonKind: DriftReason.EXPECT_ELEMENT_NOT_FOUND,
    reason: `expect.element testid "${value}" not present after the action`,
    anchor: value,
    nearest: nearestTestid(value, present),
  };
  if (nearestIsAmbiguous(value, present)) drift.ambiguous = true;
  return drift;
}

/**
 * Re-resolve any QUERY against the live DOM, tolerating an in-flight render: QUERY, and while it
 * returns zero refs, sleep and retry up to ANCHOR_SETTLE_ATTEMPTS. Returns as soon as refs appear,
 * so a present anchor costs one query; a genuinely missing one costs the full (bounded) settle and
 * then drifts. The last result's near-miss hint is returned for the drift record.
 */

/**
 * One wait between anchor attempts: the fixed tick, or the next DOM event — whichever comes first.
 *
 * An element mounting IS a mutation, and the session already streams those, so sleeping out the rest
 * of a 150ms tick after the thing has already appeared is pure latency. Measured on next-app-router:
 * a single `flow.step` span was 1079ms around nine QUERY round-trips of 1–2ms each — the cost was
 * entirely the sleeping, and four such steps made up 4.3s of that app's 7.6s.
 *
 * It can only resolve the wait EARLIER, never end the loop earlier: the attempt budget above is
 * untouched, so a genuinely missing anchor still spends the full settle before it drifts. An early
 * "not found" would be a false drift, which is the failure this loop exists to prevent.
 */
async function settleTick(session: FlowReplaySession, sleep: Sleep): Promise<void> {
  let unsubscribe: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      unsubscribe = session.onEvent(finish);
      void sleep(ANCHOR_SETTLE_DELAY_MS).then(finish);
    });
  } finally {
    unsubscribe?.();
  }
}

export async function resolveQuery(
  session: FlowReplaySession,
  queryArgs: Record<string, unknown>,
  sleep: Sleep,
  now: () => number = Date.now,
): Promise<{ refs: string[]; hint?: QueryEmptyHint }> {
  let last = readQuery(await session.command(ReticleCommand.QUERY, queryArgs));
  const deadline = now() + ANCHOR_SETTLE_BUDGET_MS;
  for (
    let attempt = 1;
    0 === last.refs.length && now() < deadline && attempt < ANCHOR_SETTLE_MAX_ATTEMPTS;
    attempt += 1
  ) {
    await settleTick(session, sleep);
    last = readQuery(await session.command(ReticleCommand.QUERY, queryArgs));
  }
  return last;
}

/** Re-resolve a testid anchor. */
export function resolveTestid(
  session: FlowReplaySession,
  value: string,
  sleep: Sleep,
): Promise<{ refs: string[]; hint?: QueryEmptyHint }> {
  return resolveQuery(session, { by: QueryBy.TESTID, value }, sleep);
}

/** A compact, legible label for a component auto-anchor (component@file:line, or its best part). */
export function componentLabel(
  anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.COMPONENT }>,
): string {
  if (anchor.source !== undefined) {
    const base = anchor.source.file.split('/').pop() ?? anchor.source.file;
    const loc = `${base}:${anchor.source.line}`;
    return anchor.component !== undefined ? `${anchor.component}@${loc}` : loc;
  }
  return anchor.component ?? anchor.name ?? anchor.role ?? 'component';
}

/** The value of a step's primary anchor, for labelling the result row. */
export function anchorLabel(anchor: FlowAnchor): string {
  if (anchor.kind === AnchorKind.TESTID) return anchor.value;
  if (anchor.kind === AnchorKind.SIGNAL) return anchor.name;
  if (anchor.kind === AnchorKind.COMPONENT) return componentLabel(anchor);
  return anchor.name ?? anchor.role;
}

/** QUERY args for a component auto-anchor — source (precise) + component name (coarse) as given. */
export function componentQueryArgs(
  anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.COMPONENT }>,
): Record<string, unknown> {
  const args: Record<string, unknown> = { by: QueryBy.COMPONENT };
  if (anchor.component !== undefined) args['component'] = anchor.component;
  if (anchor.source !== undefined) args['source'] = anchor.source;
  return args;
}
