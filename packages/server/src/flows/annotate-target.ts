/**
 * Which recording an annotation belongs to when the call does not say.
 *
 * It used to be the literal name `default`, unconditionally. Reproduced on three apps: an agent that
 * starts `reticle_record { recordingName: "my-flow" }`, acts, and then annotates without repeating
 * the name gets `annotate_no_step` — because the steps are in "my-flow" and the annotation went
 * looking in an empty "default". The agent's rational next move is to record MORE steps, into the
 * wrong place.
 *
 * With exactly one recording in progress there is nothing to disambiguate, so that is the answer.
 * With several, `default` stays the documented choice: silently picking one of the others would put
 * an assertion in a flow the agent never named, which is worse than an error.
 */
/** The documented fallback name, matching what `reticle_record` starts when given none. */
const DEFAULT_RECORDING = 'default';

export function resolveAnnotateTarget(
  explicit: string | undefined,
  active: readonly string[],
): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return 1 === active.length ? (active[0] ?? DEFAULT_RECORDING) : DEFAULT_RECORDING;
}
