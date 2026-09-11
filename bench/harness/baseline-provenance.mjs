/**
 * Was the baseline measured by the same instrument as the fresh run?
 *
 * Every gated dimension in this harness compares a fresh number against a recorded one, and that
 * comparison silently assumes both were produced the same way. For most of this project's life that
 * assumption was false and nothing checked it.
 *
 * The rows written before the integrity pass came from a harness with four defects that ALL read in
 * our favour: a measured-nothing guard that covered four of twelve passes, a lost cell that left the
 * denominator so catch-rate held at 1.0 while coverage shrank, two tools that never ran recorded as
 * having scored zero across the whole grid, and a scenario every tool "detected" by matching a word
 * in the request URL.
 *
 * Such a row is not stale, which would be survivable. It is the wrong number, biased in one
 * direction, and comparing an honest run against it INVERTS the gate: the honest measurement reads as
 * a regression, and a genuine regression can hide inside the slack the old flattery left behind. The
 * failure that costs the most here is the one that still looks like a pass.
 *
 * ## Why a revision integer and not a date or a git sha
 *
 * A date cannot express "this change did not affect comparability", and most harness edits do not.
 * A sha changes on every commit and would refuse every baseline, which is a gate nobody can satisfy
 * and therefore a gate somebody deletes. The revision is bumped by hand, and only when a change makes
 * past measurements incomparable — which is a judgement, and belongs to a person.
 *
 * An unstamped row is refused rather than trusted. Absence is not evidence of sameness, and here it
 * is better than that: unstamped is exactly the set of rows known to have been measured differently.
 */

/**
 * Bump this ONLY when a harness change makes previously recorded rows incomparable.
 *
 * 1 — the integrity pass: the measured-nothing guard covers every pass shape, a lost cell fails the
 *     gate instead of leaving the denominator, tools that did not run are absent rather than scored
 *     zero, and the network-timeout scenario grades an observed unresolved request rather than a
 *     string that appears in the URL.
 */
export const HARNESS_REVISION = 1;

/**
 * Compare the baseline's provenance against the running harness.
 *
 * Returns `{ ok, reason }` rather than throwing, so the caller decides whether it is fatal — the gate
 * collects several verdicts and reports them together rather than dying on the first.
 */
export function provenanceVerdict({ baseline, current = HARNESS_REVISION } = {}) {
  if (null === baseline || undefined === baseline) {
    return { ok: true, reason: 'no baseline to compare against, which is a first run' };
  }

  const stamped = baseline.harness_revision;
  const label = 'string' === typeof baseline.version ? baseline.version : 'unlabelled';

  if ('number' !== typeof stamped || !Number.isInteger(stamped)) {
    return {
      ok: false,
      reason:
        `the baseline row (${label}) carries no harness revision, so it was recorded before the ` +
        `instrument was fixed. Those rows were measured by a harness whose defects all read in our ` +
        `favour, so comparing against one inverts this gate: an honest run looks like a regression, ` +
        `and a real regression hides in the slack. Re-baseline on main before measuring anything — ` +
        `run the full benchmark and record a fresh row.`,
    };
  }

  if (stamped < current) {
    return {
      ok: false,
      reason:
        `the baseline row (${label}) was recorded by harness revision ${String(stamped)} and this ` +
        `is revision ${String(current)}. The instrument changed in a way that makes the two ` +
        `incomparable. Re-baseline on main before measuring anything.`,
    };
  }

  if (stamped > current) {
    return {
      ok: false,
      reason:
        `the baseline row (${label}) was recorded by harness revision ${String(stamped)}, which is ` +
        `NEWER than this checkout's revision ${String(current)}. Comparing would measure the ` +
        `difference between two harnesses and report it as a change in the product. Update the ` +
        `checkout rather than the row.`,
    };
  }

  return { ok: true, reason: `baseline (${label}) was measured by this harness revision` };
}
