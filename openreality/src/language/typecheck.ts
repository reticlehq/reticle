/**
 * TYPECHECK — refuse a document before an action is spent.
 *
 * `Realm.perform` already refuses an undeclared capability. It does so at RUNTIME, one action at a
 * time, after the action has been dispatched and the subject has already moved. That is the right
 * answer to the wrong question: a journey recorded on a browser and replayed on a realm that cannot
 * swipe should be refused as a DOCUMENT, naming what is missing, rather than discovered at step 7 of
 * a journey that has already half-happened and cannot be un-happened.
 *
 * It is the protocol's own rule applied to a whole program instead of one claim — *a claim reading a
 * channel that is not here is `unknown` immediately, rather than after the action has been spent.*
 *
 * It is also what turns portability from an aspiration into a CHECK. The same source document runs
 * on any realm whose instruction set covers it, and when it does not, this says which capability is
 * missing rather than failing halfway.
 *
 * Pure, and deliberately ignorant of any particular flow format: a program is a list of (capability,
 * channels it reads), and any tool that can produce that can be typechecked without importing a line
 * of Reticle's TypeScript.
 */

import type { ChannelId } from '../vocabulary/channel.js';

export const TypeErrorKind = {
  /** The realm cannot do this. Checked against `capabilities()`. */
  UNDECLARED_CAPABILITY: 'undeclared-capability',
  /** The realm cannot SEE this. Checked against `channels()`. */
  UNOBSERVED_CHANNEL: 'unobserved-channel',
  /** An `invoke` names a document that is not in the set being checked. */
  UNRESOLVED_FLOW: 'unresolved-flow',
  /** Following `invoke` edges comes back to a document already on the path. */
  CYCLIC_INVOCATION: 'cyclic-invocation',
  /** What the journey has established does not meet what the next document declares it needs. */
  UNSATISFIED_REQUIREMENT: 'unsatisfied-requirement',
  /** A document declares `requires` and the realm cannot say whether it holds. */
  UNJUDGED_REQUIREMENT: 'unjudged-requirement',
} as const;
export type TypeErrorKind = (typeof TypeErrorKind)[keyof typeof TypeErrorKind];

/**
 * WHERE a step is, when "step 4" is no longer an answer.
 *
 * In a flat document an index is an address. In a composite it is not: step 2 of which document,
 * reached how? Two journeys sharing a sub-flow produce the same number for different failures, and
 * a reader has to open every document to find out which one moved.
 *
 * `via` is the invocation chain, NEAREST CALLER FIRST, so reading it left to right walks outward
 * the way a stack trace does. Empty at the top level, which is the common case and costs nothing.
 */
export interface StepAddress {
  /** The document the step is written in. */
  flow: string;
  /** 0-based index within THAT document. */
  step: number;
  /** How the replay arrived, nearest caller first. Empty when the document is the entry. */
  via: readonly { flow: string; step: number }[];
}

/** `onboarding/signup#2 (invoked from onboarding/full#1)` — one line a person can act on. */
export function formatStepAddress(at: StepAddress): string {
  const here = `${at.flow}#${String(at.step)}`;
  if (0 === at.via.length) return here;
  return `${here} (invoked from ${at.via.map((v) => `${v.flow}#${String(v.step)}`).join(', ')})`;
}

export interface FlowTypeError {
  /**
   * 0-based index of the offending step.
   *
   * Kept alongside `at` rather than replaced by it: every caller reading this today is checking a
   * flat program, where the index IS the address, and breaking them to add composition would be
   * charging the simple case for the complex one.
   */
  step: number;
  /** Where the step lives, for a composite. Absent when the check was over a flat program. */
  at?: StepAddress;
  kind: TypeErrorKind;
  detail: string;
}

/** One step, reduced to what a typecheck needs: what it does, and what it reads to know it worked. */
export interface ProgramStep {
  capability: string;
  reads?: readonly ChannelId[];
}

/** What the target realm says it can do and see — `capabilities()` and `channels()`, nothing else. */
export interface RealmSurface {
  capabilities: readonly string[];
  channels: readonly ChannelId[];
}

/**
 * Every problem, not just the first.
 *
 * A compiler that stops at the first error makes the caller re-run it once per mistake, and the
 * caller here is often an agent paying a turn each time. One pass, one fix list.
 *
 * An EMPTY program typechecks. It asserts nothing, which is a coverage question and a real one —
 * but it is not a type error, and conflating the two would have this refuse documents for being
 * weak rather than for being unrunnable.
 */
export function typecheckProgram(
  steps: readonly ProgramStep[],
  realm: RealmSurface,
): FlowTypeError[] {
  const canDo = new Set(realm.capabilities);
  const canSee = new Set<string>(realm.channels);
  const errors: FlowTypeError[] = [];
  steps.forEach((step, index) => {
    if (!canDo.has(step.capability)) {
      errors.push({
        step: index,
        kind: TypeErrorKind.UNDECLARED_CAPABILITY,
        detail: `this realm cannot "${step.capability}"; it declares: ${realm.capabilities.join(', ') || '(nothing)'}`,
      });
      // One finding per step: a step that cannot run is not also interesting for what it would have
      // read. Reporting both would pad the list with consequences of the error already named.
      return;
    }
    for (const channel of step.reads ?? []) {
      if (canSee.has(channel)) continue;
      errors.push({
        step: index,
        kind: TypeErrorKind.UNOBSERVED_CHANNEL,
        detail: `step reads "${channel}", which this realm does not observe; it sees: ${realm.channels.join(', ') || '(nothing)'}`,
      });
    }
  });
  return errors;
}

/** A document reduced to what composition needs: its name, its state contract, and what it invokes. */
export interface CompositeDocument {
  name: string;
  /** What must hold before step 1. Realm-opaque — this module never looks inside it. */
  requires?: unknown;
  /** What a caller may assume afterwards. Realm-opaque. */
  ensures?: unknown;
  steps: readonly { invoke?: string }[];
}

/**
 * Does what the journey has established meet what the next document needs?
 *
 * Supplied by the REALM, because only it knows what its own state values mean — a protocol that
 * compared these would be a protocol with an opinion about what a subject is, which is the opinion
 * it exists not to have.
 *
 * `undefined` is a real and expected answer: "I cannot tell." It must never be read as agreement.
 * A check that treats "cannot tell" as "yes" can only ever pass, and a guard that cannot fail is
 * worse than no guard, because it reads as one.
 */
export type SatisfiesRequirement = (ensures: unknown, requires: unknown) => boolean | undefined;

/**
 * Refuse a composite by READING it — no realm, no subject, no action spent.
 *
 * Both failures here are unrecoverable at runtime and cheap to find at rest. A cycle discovered
 * while replaying is an infinite replay. A missing sub-document discovered while replaying is a
 * journey abandoned midway, with the subject left wherever it got to and nothing able to put it
 * back. Neither is a verdict about the app, so neither should cost the app anything.
 *
 * Depth-first with a path stack rather than a visited set alone, because the PATH is the whole
 * value of a cycle message: "there is a cycle somewhere" sends a reader through every document to
 * find what this already knew. A diamond — two routes to one leaf — is reuse, which is the point of
 * composition, so a document already finished is not a cycle and is not re-walked.
 *
 * Pure, and ignorant of any flow format: anything that can list (name, invoked names) can be checked
 * without importing a line of Reticle's TypeScript.
 */
export function typecheckComposite(
  documents: readonly CompositeDocument[],
  entry: string,
  /**
   * Omitted means the state contract is not checked at all, and that is deliberate: composition
   * without contracts is still composition, and a realm that has not implemented the comparison
   * must not have its documents refused for it.
   */
  satisfies?: SatisfiesRequirement,
): FlowTypeError[] {
  const byName = new Map(documents.map((d) => [d.name, d]));
  const errors: FlowTypeError[] = [];
  const done = new Set<string>();
  const path: string[] = [];
  let stitching = true;

  /**
   * What the journey has established by the time a step runs.
   *
   * Carried forward rather than compared pairwise, so a document three invocations later can rely
   * on something the first one established — which is how a real onboarding reads. The protocol
   * does not merge these; it hands the realm the most recent guarantee, and a realm that needs
   * accumulation can express it in its own `ensures` values.
   */
  const check = (doc: CompositeDocument, established: unknown, at: StepAddress): boolean => {
    if (!stitching || satisfies === undefined || doc.requires === undefined) return true;
    const held = satisfies(established, doc.requires);
    if (true === held) return true;
    errors.push(
      undefined === held
        ? {
            step: at.step,
            at,
            kind: TypeErrorKind.UNJUDGED_REQUIREMENT,
            detail: `"${doc.name}" declares a requirement this realm cannot judge, so the composite cannot be shown to stitch`,
          }
        : {
            step: at.step,
            at,
            kind: TypeErrorKind.UNSATISFIED_REQUIREMENT,
            detail: `"${doc.name}" needs something the journey has not established by this point`,
          },
    );
    return false;
  };

  /**
   * `at` is the CALL SITE — the step that tried to enter this document — not a position inside it.
   * That is where a fix goes: an unresolved name is fixed where it is written, and a failed stitch
   * is fixed by reordering the composite or establishing what the document needs before invoking it.
   */
  const walk = (name: string, at: StepAddress, established: unknown): unknown => {
    if (path.includes(name)) {
      errors.push({
        step: at.step,
        at,
        kind: TypeErrorKind.CYCLIC_INVOCATION,
        detail: `invocation returns to a document already running: ${[...path, name].join(' → ')}`,
      });
      return established;
    }
    const doc = byName.get(name);
    if (doc === undefined) {
      errors.push({
        step: at.step,
        at,
        kind: TypeErrorKind.UNRESOLVED_FLOW,
        detail: `no document named "${name}"; the set holds: ${[...byName.keys()].join(', ') || '(nothing)'}`,
      });
      return established;
    }
    // Only an INVOKED document is stitch-checked. The entry document's `requires` is a precondition
    // on the SUBJECT — nothing precedes it to establish anything, so judging it here would refuse
    // every composite that declares one. That check belongs at replay, against the real subject.
    if (path.length > 0 && !check(doc, established, at)) {
      // Stop stitching this branch once one requirement has failed. What the journey has
      // established is no longer knowable, so every later comparison is a consequence of the error
      // already named — the same rule `typecheckProgram` applies to a step that cannot run. The
      // structure below is still walked, because a cycle or a missing document is worth finding
      // whatever the state contract says.
      stitching = false;
    }
    // Re-walked even when already finished, because the same document reached by a second route
    // meets a DIFFERENT established state and may stitch there and not here. Cycles are still
    // caught by the path stack, so this cannot run away; `done` now only records that its own
    // structure has been checked.
    const pathDepth = path.length;
    if (!done.has(name)) {
      path.push(name);
      // The entry document's own `requires` SEEDS what is established: a composite that declares
      // it starts signed-out is telling the first invoked document exactly that. For an invoked
      // document the requirement has just been checked and held, so using it as the new baseline
      // says no more than was already proved. `ensures` wins where it is given.
      let carried = doc.ensures ?? doc.requires ?? established;
      // The chain that reached THIS document, nearest caller first. `at` is the call site that
      // invoked it, so the chain is that call site followed by whatever reached the call site. The
      // entry document has no caller, and an entry whose `at` is its own name would otherwise
      // report itself as having invoked itself.
      const chainHere = 0 === pathDepth ? [] : [{ flow: at.flow, step: at.step }, ...at.via];
      doc.steps.forEach((s, index) => {
        if (s.invoke === undefined) return;
        carried = walk(s.invoke, { flow: name, step: index, via: chainHere }, carried);
      });
      path.pop();
      done.add(name);
    }
    return doc.ensures ?? doc.requires ?? established;
  };

  walk(entry, { flow: entry, step: 0, via: [] }, undefined);
  return errors;
}
