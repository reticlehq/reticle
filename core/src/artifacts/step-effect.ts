/**
 * What a step DOES to the subject, so a resume can refuse to re-run a prefix that commits.
 *
 * Replay resumes by re-driving the steps before the one you asked for: it does not restore state,
 * because there is no way to put an app back. `flow-replay.ts` states the cost honestly — "nearly
 * free, just re-run the prefix" is true of a browser and false of a subject that COMMITS, where it
 * re-sends every request before step N. The flow could not SAY which steps those were, so the engine
 * had no way to refuse and the guard was a sentence in a comment.
 *
 * Absent means UNKNOWN, and unknown behaves exactly as it always has: the prefix is re-driven.
 * Assuming `commits` for an unlabelled step would refuse every flow recorded before this shipped,
 * which is a worse failure than the one it prevents.
 *
 * IN A LEAF OF ITS OWN, and that is not tidiness. It first landed in `flow-constants.ts`, which the
 * browser SDK's recorder imports for `FLOW_FILE_VERSION` — so this object was downloaded by every
 * instrumented page, on every load, to support a decision only the replay engine ever makes. The
 * first-load guard caught it at 79 bytes over its ceiling. The lesson is already written down beside
 * that guard: naming a single value that lives beside something heavy pulls in everything its file
 * holds, so put the value in a leaf of its own instead.
 */
export const StepEffect = {
  /** Reads the subject and changes nothing. Always safe to re-run. */
  READ: 'read',
  /** Changes state, but running it twice lands in the same place. Safe to re-run. */
  IDEMPOTENT: 'idempotent',
  /** Has an effect the subject keeps: a payment, a send, a create. NEVER re-run silently. */
  COMMITS: 'commits',
} as const;
export type StepEffect = (typeof StepEffect)[keyof typeof StepEffect];
