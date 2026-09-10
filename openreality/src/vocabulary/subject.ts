import { z } from 'zod';

/**
 * What was verified, and when in the life of the code.
 *
 * Every other noun in this protocol is scoped to a subject. An observation that cannot say which
 * running thing it came from, or which round of edits that thing was carrying, is not evidence
 * about anything -- it is a fact about some bytes.
 *
 * Two failures make this normative rather than bookkeeping, and both are recorded rather than
 * imagined:
 *
 * **The document died and the evidence outlived it.** A window is bounded by time and by buffer
 * capacity, so it can still hold the requests and errors of a page that a navigation has already
 * thrown away. Reported from the field: a failing request naming a database row that no longer
 * existed, cited as the cause of an action taken afterwards. True about the bytes, false about the
 * world, which is the worst kind of wrong a verification tool can be.
 *
 * **The code changed and the document did not.** A hot update replaces modules and re-renders
 * inside the SAME instance, so instance identity never moves and observations of code the author
 * has already rewritten go on answering for it, silently. Nothing else in this industry records
 * this, which is precisely why it must be in the protocol and not in one vendor's implementation.
 */

/**
 * The kind of place an application runs.
 *
 * Open, and deliberately not an exhaustive enum: a protocol that has to be revised to admit a new
 * kind of computer is a protocol with an expiry date. The listed values are the ones with shipping
 * implementations; anything else is a string, and an implementation naming one is conformant.
 */
export const Surface = {
  /** A page in a browser engine. */
  WEB: 'web',
  /** An application with its own shell around a webview: Electron, Tauri, and their relatives. */
  DESKTOP: 'desktop',
  /** A phone or tablet application. */
  MOBILE: 'mobile',
  /** A process with no screen: an API, a worker, a job. */
  SERVICE: 'service',
  /** A simulation with a frame loop. */
  GAME: 'game',
  /** Something with actuators, in the physical world. */
  DEVICE: 'device',
} as const;
export type Surface = (typeof Surface)[keyof typeof Surface];

export const SurfaceSchema = z.union([z.nativeEnum(Surface), z.string().min(1)]);

/**
 * The identity of the thing being verified.
 *
 * `instance` is the identity that DIES. Whatever the realm's answer is -- a document id, a renderer
 * and main-process pair, a service instance and its deploy, a play session -- the requirement is
 * the same: when the thing it names is replaced, this value must change. An implementation that
 * returns a constant here is not conformant, and the failure it produces is invisible.
 *
 * `epoch` is the round of source edits. It moves when the code under test changes WITHOUT the
 * instance being replaced. Absent means the implementation has no way to know, which is different
 * from zero -- zero is a claim that this is the first round.
 */
export const SubjectRefSchema = z.object({
  surface: SurfaceSchema,
  /** Dies when the thing it names is replaced. See above; a constant here is a silent lie. */
  instance: z.string().min(1),
  /**
   * Which round of source edits this subject is carrying.
   *
   * Optional, and absence is NOT zero. A verifier that cannot observe edits says nothing here; one
   * that says `0` is claiming the code has not been touched since it started watching.
   */
  epoch: z.number().int().nonnegative().optional(),
  /** Where the subject is, in whatever addressing its surface uses. Free-form on purpose. */
  locator: z.string().optional(),
  /** A build, commit or deploy this subject was made from, when the realm can know it. */
  revision: z.string().optional(),
});
export type SubjectRef = z.infer<typeof SubjectRefSchema>;

/** Reasons the identity of a subject can be invalidated, named so a verdict can say which. */
export const InvalidationSchema = z.object({
  /** `instance` if the thing was replaced, `epoch` if only the code changed under it. */
  kind: z.enum(['instance', 'epoch']),
  /** What it was before. */
  from: z.string(),
  /** What it is now. */
  to: z.string(),
});
export type Invalidation = z.infer<typeof InvalidationSchema>;

/**
 * Is evidence gathered under `observed` still admissible about `current`?
 *
 * The two answers differ, and the difference is the reason both fields exist.
 *
 * A changed **instance** is total: the thing is gone, along with its state, its in-flight work and
 * everything that referred to them. Nothing recorded under it is still about the world.
 *
 * A changed **epoch** is partial: most modules, most of the surface and the whole record of what
 * happened survive a hot update. Discarding that window would empty verdicts holding real findings,
 * and an emptied window reads as "nothing happened" -- the more expensive of the two wrong answers.
 *
 * So this returns admissibility, and a caller that gets `false` must report WHY rather than
 * reporting an empty window. See `AnomalyKind.EVIDENCE_SUPERSEDED` and `EVIDENCE_PREDATES_EDIT`.
 */
export function evidenceIsAdmissible(observed: SubjectRef, current: SubjectRef): boolean {
  return observed.instance === current.instance;
}

/** What changed between two observations of the same subject, or undefined if nothing did. */
export function invalidationBetween(
  observed: SubjectRef,
  current: SubjectRef,
): Invalidation | undefined {
  if (observed.instance !== current.instance) {
    return { kind: 'instance', from: observed.instance, to: current.instance };
  }
  if (
    observed.epoch !== undefined &&
    current.epoch !== undefined &&
    observed.epoch !== current.epoch
  ) {
    return { kind: 'epoch', from: String(observed.epoch), to: String(current.epoch) };
  }
  return undefined;
}
