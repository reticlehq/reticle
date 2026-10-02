import {
  EventType,
  JournalVerdictEffectSchema,
  RUN_ESTABLISHED_CAP,
  buildRunContext,
  type EstablishedFact,
  type Intent,
  type JournalAction,
  type JournalVerdictEffect,
  type ProvenClaim,
  type ReticleEvent,
  type RunContext,
} from '@reticlehq/core';

/**
 * The run, derived from the journal that is already there.
 *
 * `.reticle/sessions/<id>/` already holds an append-only causal ledger of every action dispatched
 * and every event observed. The run is a FOLD over that, never a second store — the same argument
 * that deleted `instrumentation_stalled` from this codebase applies without modification: two ways
 * to compute one number is worse than one way, because the day they disagree the disagreement lands
 * inside a verdict and a user finds it before we do. So nothing here writes: it reads the ledger and
 * folds it, and if the fold is wrong the ledger is still the single authority.
 *
 * **One run per session, for now.** Nothing here assumes it: the fold is pure and takes its evidence
 * as arguments, so a later multi-run or multi-agent model is a change of caller, not a rewrite. It
 * is not built today because nobody has hit the case, and a coordination model invented ahead of its
 * first user is a guess.
 *
 * Only what Reticle OBSERVED goes in. A settle outcome is an observation. A route change is an
 * observation. A verdict a verification tool recorded is an observation. What the agent meant to do
 * next is not, and never enters here.
 */

/**
 * The one key the route is filed under.
 *
 * The subject of "the app is on /checkout" is the route itself, so a later route change SUPERSEDES
 * rather than appends. Filing it per-path would accumulate every page ever visited, which is the
 * token bomb the cap exists to prevent.
 */
const ROUTE_KEY = 'route';

/** The conclusions this fold is allowed to state, as prose rather than transcript. */
const Fact = {
  route: (to: string): string => `route is ${to}`,
  settled: (verb: string): string => `${verb} settled`,
  unsettled: (verb: string): string => `${verb} did not settle`,
} as const;

/**
 * The SUBJECT a journal action was about: the ref it spent, else the target it resolved from.
 *
 * Exported so the feature-use instrument files a re-fetch under the same key this fold establishes
 * it under. A second copy of this rule there would be a second definition of "the same subject".
 */
export function subjectOf(action: JournalAction): string | undefined {
  const ref = action.args['ref'];
  if ('string' === typeof ref && ref.length > 0) return ref;
  const target = action.args['target'];
  if ('string' === typeof target && target.length > 0) return target;
  return undefined;
}

/** What the action did, in the caller's own vocabulary — 'click', 'fill', else the tool's name. */
function verbOf(action: JournalAction): string {
  const named = action.args['action'];
  return 'string' === typeof named && named.length > 0 ? named : action.tool;
}

/** The verdict a verification tool recorded on this action, if it recorded one. */
function verdictOf(action: JournalAction): JournalVerdictEffect | undefined {
  const parsed = JournalVerdictEffectSchema.safeParse(action.effect);
  return parsed.success ? parsed.data : undefined;
}

/** Which document and edit epoch each action was observed under, read off its attributed events. */
function scopeByAction(
  events: readonly ReticleEvent[],
): Map<string, { doc?: string | undefined; epoch?: number | undefined }> {
  const out = new Map<string, { doc?: string | undefined; epoch?: number | undefined }>();
  for (const event of events) {
    if (event.actionId === undefined) continue;
    if (event.documentId === undefined && event.editEpoch === undefined) continue;
    const existing = out.get(event.actionId) ?? {};
    out.set(event.actionId, {
      doc: event.documentId ?? existing.doc,
      epoch: event.editEpoch ?? existing.epoch,
    });
  }
  return out;
}

/**
 * Fold the journal into candidate facts, newest last.
 *
 * Only the last `RUN_ESTABLISHED_CAP` actions are read: anything older cannot survive the fold, so
 * parsing it would be work done to throw away. An action with no observed settle outcome states
 * nothing and is skipped — "we drove it and cannot say what happened" is not an established fact,
 * and writing it down as one is how a memory starts lying.
 */
export function establishedFromJournal(
  actions: readonly JournalAction[],
  events: readonly ReticleEvent[],
): EstablishedFact[] {
  const scope = scopeByAction(events);
  let route: EstablishedFact | undefined;
  for (const event of events) {
    if (EventType.ROUTE_CHANGE !== event.type) continue;
    const pathname = event.data['pathname'];
    const to = 'string' === typeof pathname ? pathname : event.data['to'];
    if ('string' !== typeof to) continue;
    route = { key: ROUTE_KEY, fact: Fact.route(to), doc: event.documentId, epoch: event.editEpoch };
  }

  const out: EstablishedFact[] = [];
  for (const action of actions.slice(-RUN_ESTABLISHED_CAP)) {
    const settled = action.settled;
    if (undefined === settled) continue;
    const key = subjectOf(action);
    if (undefined === key) continue;
    const verb = verbOf(action);
    out.push({
      key,
      fact: settled ? Fact.settled(verb) : Fact.unsettled(verb),
      // The source pointer the verdict already reported. Read off the ledger rather than looked up
      // again: a second lookup could disagree with the one the agent was shown.
      source: verdictOf(action)?.source,
      ...(scope.get(action.actionId) ?? {}),
    });
  }
  if (route !== undefined) out.push(route);
  return out;
}

/**
 * What a verdict already settled, newest last.
 *
 * Both verdict tools write here. `reticle_act_and_wait` closes its attribution window with one;
 * `reticle_assert` drives nothing, so it appends its record WITHOUT opening a window — same effect
 * shape, so this fold reads one kind of verdict rather than two.
 */
export function provenFromJournal(
  actions: readonly JournalAction[],
  events: readonly ReticleEvent[],
): ProvenClaim[] {
  const scope = scopeByAction(events);
  const out: ProvenClaim[] = [];
  for (const action of actions.slice(-RUN_ESTABLISHED_CAP)) {
    const verdict = verdictOf(action);
    if (undefined === verdict) continue;
    out.push({
      claim: verdict.claim,
      verified: verdict.verified,
      source: verdict.source,
      ...(scope.get(action.actionId) ?? {}),
    });
  }
  return out;
}

/**
 * The context for one run.
 *
 * `step` is the journal's action count rather than a counter of its own, for the reason at the top
 * of this file: a second counter is a second thing that can disagree with the ledger. The document
 * and epoch are the session's own, so the staleness rule here is the same one every other verdict in
 * this codebase is scoped by.
 */
export function runContextFor(input: {
  actions: readonly JournalAction[];
  events: readonly ReticleEvent[];
  intents: readonly Intent[];
  currentDocumentId: string | undefined;
  currentEditEpoch: number | undefined;
}): RunContext {
  return buildRunContext({
    step: input.actions.length,
    intents: input.intents,
    established: establishedFromJournal(input.actions, input.events),
    proven: provenFromJournal(input.actions, input.events),
    currentDocumentId: input.currentDocumentId,
    currentEditEpoch: input.currentEditEpoch,
  });
}
