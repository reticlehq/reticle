/**
 * What a run has established, held so the agent can ASK for it back.
 *
 * Verification is multi-step, and the only thing holding the thread together is the agent's own
 * context window. When that compacts, or the turn ends, or a sub-agent takes over, the thread is
 * gone and the work restarts. The shape of that shows in the field without needing the theory: long
 * runs of the same read-only call, an agent searching by exhaustion because it no longer remembers
 * what it already saw.
 *
 * ## Pulled, never pushed
 *
 * An earlier version of this rode along on every tool response. It cost +136% on a verdict and was
 * cut, because the agent still had most of that context most of the time: we paid on every call to
 * duplicate what it already knew. The asymmetry that makes the feature work is not that Reticle
 * remembers MORE, it is that Reticle's copy does not degrade at the moment the agent's does. So the
 * agent asks, at the moment it knows its own memory is gone, and pays once.
 *
 * That inversion is why nothing here returns `undefined` for an empty run. A push had to stay silent
 * when it had nothing to say; a pull was asked a question, and "nothing established yet" is the
 * answer the asker needs.
 *
 * ## Two rules stop it becoming the thing it prevents
 *
 * **It must shrink, not grow.** Superseding facts REPLACE rather than append, and both blocks are
 * capped. A context object that accumulates is a token bomb, and read-only payloads are already the
 * largest thing this product emits.
 *
 * **Memory that can be wrong is worse than no memory.** A stale established fact is precisely the
 * false-green mechanism this product exists to prevent, and stale refs are already the most common
 * error an agent sees from us. So every fact carries the document AND the edit epoch it was observed
 * under, and is dropped the moment either moves: no grace period, no probably-fine. The comparison
 * is `isSameDocument`/`isSameEditEpoch` rather than a third rule written beside them.
 *
 * ## What may never go in
 *
 * Only what Reticle OBSERVED. Never what the agent intends, plans, or believes: that is not ours to
 * hold, it is unbounded, and a verification tool that remembers what an agent was thinking is
 * inventing evidence. `remaining` is the one forward-looking field and it is derived mechanically
 * from declared bindings, so it remains a report of a fact — which bindings are undischarged — and
 * not a prediction.
 */

import { isSameDocument } from './document-identity.js';
import { isSameEditEpoch } from './edit-epoch.js';
import { IntentState, type Intent } from './intent.js';
import type { Verified } from './verified-constants.js';

/**
 * How many rows either block may carry.
 *
 * A decision written down in one place, because the whole feature is a bet that this answer costs
 * fewer tokens than the re-derivation it prevents, and a cap that drifts makes that bet
 * unmeasurable. Twelve is enough to hold the refs, routes and verdicts a single verification thread
 * works with, and small enough that the answer stays a briefing rather than a second payload.
 *
 * One number for both blocks on purpose: two caps is two things to keep in step, and nothing has
 * ever suggested proofs and observations deserve different budgets.
 */
export const RUN_ESTABLISHED_CAP = 12;

/**
 * Evidence scoped to the page and the source revision it was taken under.
 *
 * Both fields are optional and absence means "current", exactly as `isSameDocument` and
 * `isSameEditEpoch` already rule: an SDK predating either stamps nothing, and a page with no
 * hot-update channel never stamps an epoch at all.
 */
interface ScopedEvidence {
  /** The document this was seen under. Absent only from evidence predating document identity. */
  readonly doc?: string | undefined;
  /** The edit epoch this was seen under. Absent where no hot update could ever be observed. */
  readonly epoch?: number | undefined;
}

/**
 * One thing this run established, with the page state it was true under.
 *
 * `key` is the SUBJECT — re-establishing the same subject supersedes rather than appends. `fact` is
 * the conclusion in prose, never the transcript it came from: "e12 is the Submit button", not the
 * snapshot that revealed it.
 */
export interface EstablishedFact extends ScopedEvidence {
  readonly key: string;
  readonly fact: string;
  /** Where in the source this was about, `file:line`, when the run observed one. */
  readonly source?: string | undefined;
}

/**
 * One claim a verdict already settled.
 *
 * The claim IS the subject: proving the same thing twice is one row, the newer one. An agent that
 * has forgotten it proved something either re-proves it, which is slow, or assumes it, which is a
 * false green — and both are the failure this block exists to stop, so `verified` travels with the
 * claim rather than being flattened to a boolean.
 */
export interface ProvenClaim extends ScopedEvidence {
  readonly claim: string;
  readonly verified: Verified;
  readonly source?: string | undefined;
}

/** What this run has established, what it has proved, and what nothing has discharged. */
export interface RunContext {
  readonly step: number;
  readonly established: readonly EstablishedFact[];
  readonly proven: readonly ProvenClaim[];
  readonly remaining: readonly string[];
}

/** Is this evidence still describing the page and the source revision in force? */
function isCurrent(
  evidence: ScopedEvidence,
  currentDocumentId: string | undefined,
  currentEditEpoch: number | undefined,
): boolean {
  return (
    isSameDocument(evidence.doc, currentDocumentId) &&
    isSameEditEpoch(evidence.epoch, currentEditEpoch)
  );
}

/**
 * Drop what a navigation or an edit invalidated, supersede what was re-observed, keep the most
 * recent within the cap.
 *
 * One fold with a key function rather than two, because `established` and `proven` obey the same
 * three rules and a second copy is a second place for them to drift apart.
 */
function foldScoped<T extends ScopedEvidence>(
  existing: readonly T[],
  incoming: readonly T[],
  keyOf: (row: T) => string,
  currentDocumentId: string | undefined,
  currentEditEpoch: number | undefined,
): T[] {
  const current = (row: T): boolean => isCurrent(row, currentDocumentId, currentEditEpoch);

  // Supersede WITHIN the batch as well as against the prior set. `buildRunContext` folds against an
  // empty prior set, so a rule that only ever applied to `existing` never applied at all there — and
  // the envelope's whole contract is that `key` is the subject and re-observing it replaces rather
  // than appends. A driven session showed the same ref twice and the same claim three times:
  // duplicates in the one payload whose entire purpose is a cheap context restore.
  //
  // Last wins, because the newest reading is the true one. Insertion order is preserved from the
  // LAST occurrence, so a re-observed subject moves to the recent end where the cap protects it.
  const fresh = new Map<string, T>();
  for (const row of incoming) {
    if (!current(row)) continue;
    const key = keyOf(row);
    fresh.delete(key);
    fresh.set(key, row);
  }

  const superseded = new Set(fresh.keys());
  const kept = existing.filter((row) => current(row) && !superseded.has(keyOf(row)));
  // Oldest first, so trimming from the front drops the least recent. `slice` on the tail keeps the
  // newest, which is the half a next step is most likely to need.
  return [...kept, ...fresh.values()].slice(-RUN_ESTABLISHED_CAP);
}

/** Fold new observations into the established set. See `foldScoped`. */
export function foldEstablished(
  existing: readonly EstablishedFact[],
  incoming: readonly EstablishedFact[],
  currentDocumentId: string | undefined,
  currentEditEpoch: number | undefined,
): EstablishedFact[] {
  return foldScoped(existing, incoming, (f) => f.key, currentDocumentId, currentEditEpoch);
}

/** Fold new verdicts into the proven set, keyed on the claim. See `foldScoped`. */
export function foldProven(
  existing: readonly ProvenClaim[],
  incoming: readonly ProvenClaim[],
  currentDocumentId: string | undefined,
  currentEditEpoch: number | undefined,
): ProvenClaim[] {
  return foldScoped(existing, incoming, (p) => p.claim, currentDocumentId, currentEditEpoch);
}

/**
 * The declared intents no verdict has discharged yet.
 *
 * Derived, never inferred. This reports a property of the ledger — which bindings remain unproved —
 * and says nothing about what the agent means to do next.
 */
export function remainingFor(intents: readonly Intent[]): string[] {
  return intents.filter((i) => IntentState.PROVED !== i.state).map((i) => i.statement);
}

/** Assemble the answer. Always answers: an empty run has an empty context, and that is the truth. */
export function buildRunContext(input: {
  step: number;
  intents: readonly Intent[];
  established: readonly EstablishedFact[];
  proven: readonly ProvenClaim[];
  currentDocumentId: string | undefined;
  currentEditEpoch: number | undefined;
}): RunContext {
  return {
    step: input.step,
    established: foldEstablished(
      [],
      input.established,
      input.currentDocumentId,
      input.currentEditEpoch,
    ),
    proven: foldProven([], input.proven, input.currentDocumentId, input.currentEditEpoch),
    remaining: remainingFor(input.intents),
  };
}
