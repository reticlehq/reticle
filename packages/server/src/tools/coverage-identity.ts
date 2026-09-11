/**
 * Which controls has the agent actually driven — across re-renders.
 *
 * Coverage was counted by REF, and a ref is invalidated whenever the DOM changes. Reported from a
 * sweep of a Next app-router project: `total: 34, exercised: 0` after four successful acts. App
 * router replaces a whole route segment on navigation, so every control the agent drove is a new
 * element by the time coverage is asked. The number is then 0 forever on any framework that replaces
 * nodes rather than reconciling in place — and an agent told it has exercised none of 34 controls
 * re-drives ground it already covered, which is the exact opposite of what this tool is for.
 *
 * Bench-app hid it: it reconciles in place, so refs survive there and the number looked right.
 *
 * The LABEL is the identity that survives a re-render — `button "Deploy"` names the same control
 * before and after — and it is already parsed for the untouched list.
 *
 * One caveat, stated because it is a real limitation: two controls sharing a label are
 * indistinguishable here, so driving one marks both. That errs toward "covered", which is the
 * unsafe direction for a coverage number — but it is bounded to same-labelled controls, and the
 * alternative it replaces reported ZERO coverage on entire frameworks.
 */

interface CoverageControl {
  ref: string;
  label: string;
}

interface CoverageTally {
  /** Controls on the page the agent has driven, by ref or by surviving label. */
  exercised: number;
  /** Controls the agent drove that are on the page no longer, and no label explains. */
  droveGone: number;
  /** The controls still untouched, in document order. */
  untouched: CoverageControl[];
}

export function exercisedCount(
  controls: readonly CoverageControl[],
  actedRefs: ReadonlySet<string>,
  actedLabels: ReadonlySet<string>,
): CoverageTally {
  // An empty label is not an identity — anonymous controls would otherwise collapse into one bucket
  // and a single act would mark every one of them driven.
  // Matched on the whole label (`button "Save"`) OR on a testid the label contains. The snapshot
  // renders a control's testid inside its label, and a testid is the identity most likely to survive
  // a re-render — matching only the full label meant a control with a testid but no accessible name
  // was never recognised, and coverage read `exercised: 0` after real work.
  const droveLabel = (label: string): boolean => {
    if (0 === label.length) return false;
    if (actedLabels.has(label)) return true;
    for (const acted of actedLabels) {
      if (acted.length > 0 && !acted.includes('"') && label.includes(acted)) return true;
    }
    return false;
  };
  const untouched = controls.filter(
    (control) => !actedRefs.has(control.ref) && !droveLabel(control.label),
  );
  // A driven ref that is not on the page is only "gone" if no present control carries its label —
  // otherwise it is the same control after a re-render, which is the case this exists to fix.
  const presentRefs = new Set(controls.map((control) => control.ref));
  const explainedByLabel = new Set(
    controls.filter((control) => droveLabel(control.label)).map((control) => control.label),
  );
  const droveGone = [...actedRefs].filter(
    (ref) => !presentRefs.has(ref) && 0 === explainedByLabel.size,
  ).length;
  return { exercised: controls.length - untouched.length, droveGone, untouched };
}
