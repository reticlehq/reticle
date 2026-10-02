/**
 * "Did this replay actually pass?" — asked once, so two specs cannot answer it differently.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
 * Both flow specs graded a replay with `(rep.ok !== false) && !rep.drift`. `FlowReplayResult` has
 * NEITHER field — `ok` and `drift` belong to `FlowStepResult`, one level down. So both operands were
 * `undefined` on every result, the predicate was constant true, and the check went green for
 * `status:'error'`, for zero steps, for `{}`. In the self-heal spec it was the ONLY assertion that
 * healing produced a working flow.
 *
 * That is the exact failure this product exists to refuse, sitting in the gate for the feature v3 is
 * named for.
 *
 * `unverifiable` is part of the answer rather than an extra: the replay tool sets it on an `ok`
 * replay whose flow asserts no observable consequence, and its own description says such an ok
 * "would read ok even if the feature were broken, so do NOT treat that ok as proof". A green that
 * ignores it is the same lie one layer up.
 */

/** Why this replay is not a pass, or undefined when it is one. */
export function replayNotGreen(replay) {
  if (typeof replay !== 'object' || replay === null) return `result was ${JSON.stringify(replay)}`;
  if (replay.status !== 'ok') {
    const detail = replay.error?.code ?? replay.steps?.find((s) => s.ok === false)?.drift?.reason;
    return `status ${JSON.stringify(replay.status)}${detail ? ` (${detail})` : ''}`;
  }
  if (!Array.isArray(replay.steps) || replay.steps.length === 0) return 'ok with no steps ran';
  if (replay.unverifiable !== undefined) {
    return `ok but unverifiable: ${replay.unverifiable.reason}`;
  }
  if (replay.halted !== undefined) {
    return `halted at step ${replay.halted.atStep}, ${replay.halted.notAttempted} never attempted`;
  }
  const failed = replay.steps.filter((s) => s.ok === false);
  if (failed.length > 0) return `${failed.length} of ${replay.steps.length} steps failed`;
  return undefined;
}

/** True only when the replay ran every step and proved something. */
export function replayIsGreen(replay) {
  return replayNotGreen(replay) === undefined;
}
