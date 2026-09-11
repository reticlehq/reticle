/**
 * Did a recorded flow actually TOUCH the anchor its cell is about to break?
 *
 * `replay-detect.mjs` states the precondition at the top of the file — "all break targets are
 * reliably present at record time, so the recording captures the click — a precondition for replay
 * to later catch its removal" — and nothing ever checked it.
 *
 * When a recording truncates, the flow saves with `status: ok` and only the login steps, the break
 * is injected into a control the flow never reaches, and the replay comes back clean. The cell then
 * scores `detected: false`, which reads as "replay missed a regression" when the truth is "this cell
 * measured nothing" — and the cost ratio prints beside it either way, so the row looks measured.
 *
 * Observed: d-verify-500, c-verify-500 and network-cardinality each recorded exactly the three login
 * steps, and the detection layer reported 0/3 and 0/2 over flows that never left the login screen.
 * A cell that cannot possibly detect must say so rather than score a zero.
 *
 * Pure and separate from the bench so it is unit-tested, the same reason coverage-floor.mjs is.
 */

/** The anchors a saved flow actually drove, in order. Tolerates either step shape. */
export function anchorsOf(savedFlow) {
  const steps = Array.isArray(savedFlow?.steps) ? savedFlow.steps : [];
  return steps.map((s) => s?.anchor?.value ?? s?.target?.value ?? null).filter((v) => null !== v);
}

/**
 * `{ ok: true }`, or `{ ok: false, reason }` naming what was recorded instead.
 *
 * Returns rather than throws so the caller decides whether one unmeasurable cell stops the pass.
 */
export function recordingReachedAnchor(flowName, breakId, savedFlow) {
  const anchors = anchorsOf(savedFlow);
  if (anchors.includes(breakId)) return { ok: true };
  const stepCount = Array.isArray(savedFlow?.steps) ? savedFlow.steps.length : 0;
  return {
    ok: false,
    reason:
      `${flowName}: the recording never touched "${breakId}", so breaking it cannot be detected — ` +
      `this cell would score a silent 0. Recorded ${String(stepCount)} step(s): ` +
      `${anchors.join(' > ') || '(none)'}. The recording truncated; do NOT read the detection ratio ` +
      `from this run.`,
  };
}
