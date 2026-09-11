/**
 * Did declaring an intent and having context available make verification WORSE?
 *
 * Three features shipped whose cost is measured and whose benefit is not. This is the rule that
 * decides what the two arms mean, kept pure and unit-tested for the same reason `coverage-floor.mjs`
 * and `playwright-parity.mjs` are: the gate has no test harness of its own, so the rules it enforces
 * must not live inside it.
 *
 * ## The three outcomes, and why they must stay distinct
 *
 * - **regressed** — the false-green rate is HIGHER with intent+context on, by more than the run-to-
 *   run noise. This is the one result that must never pass quietly: it says the feature makes the
 *   agent call things done that are not.
 * - **not-measured** — an arm did not run, or produced no gradeable claim. It FAILS, because a pass
 *   that measured nothing must never look like a green. It is worded as its own thing so nobody
 *   reads "we did not measure this" as "this regressed".
 * - **inconclusive** — both arms ran and the difference is inside the noise. That is not a failure;
 *   it is the honest answer, and reporting it as a win is how a benchmark stops being worth reading.
 *
 * ## Why the noise floor is the observed spread and not a constant
 *
 * A tolerance typed into this file would be a claim about how variable a real LLM loop is, made by
 * somebody who has not run it. The spread ACROSS RUNS WITHIN AN ARM is that same variability,
 * measured on the same day, on the same machine, against the same fixture. If a between-arm
 * difference is no larger than the within-arm difference, nothing has been shown.
 *
 * With fewer than two runs per arm the spread is unobservable, so the difference cannot be compared
 * against anything. That does not become a pass with a nice number: it becomes `inconclusive`, and
 * the reason says to re-run with `--runs 3` or more. One run per arm proves nothing, and a gate that
 * pretends otherwise is worse than no gate.
 */

const NOT_MEASURED = 'NOT MEASURED (this is not a regression — it is an absence of evidence). ';

function armProblem(arm, label) {
  if (null === arm || undefined === arm || true !== arm.present) {
    return `the ${label} arm did not run at all, so there is nothing to compare`;
  }
  if ('number' !== typeof arm.false_green_rate) {
    return (
      `the ${label} arm ran ${String(arm.runs ?? 0)} time(s) but produced no gradeable claim, so ` +
      `its false-green rate has an empty denominator — which is unmeasured, not zero`
    );
  }
  return null;
}

/**
 * Compare the two arms on the headline metric.
 *
 * `runs` is what the operator ASKED for; the arms carry what actually happened. They can disagree —
 * a run that crashed leaves the request intact and the arm short — and the arms are what is graded.
 *
 * Returns `{ ok, measured, outcome, reason, delta, noise }`; the caller decides fatality, matching
 * every other rule module here.
 */
export function intentEffectVerdict({ off, on, runs } = {}) {
  const requested = 'number' === typeof runs ? runs : null;

  for (const [arm, label] of [
    [off, 'OFF (no intent, no context)'],
    [on, 'ON (intent declared, context available)'],
  ]) {
    const problem = armProblem(arm, label);
    if (null !== problem) {
      return {
        ok: false,
        measured: false,
        outcome: 'not-measured',
        reason:
          NOT_MEASURED +
          `${problem}. Re-run \`pnpm bench:intent-effect --runs 3\` with ANTHROPIC_API_KEY set and ` +
          `the bench fixtures up. Recording this as a pass would say the feature was checked when it ` +
          `was not; recording it as a regression would say something we have no data for.`,
        delta: null,
        noise: null,
      };
    }
  }

  const delta = +(on.false_green_rate - off.false_green_rate).toFixed(3);
  const withinArm = [off.false_green_spread, on.false_green_spread].filter(
    (v) => 'number' === typeof v,
  );
  const noise = 0 === withinArm.length ? null : Math.max(...withinArm);
  const rates =
    `false-green rate ${String(off.false_green_rate)} (OFF, ${String(off.runs)} run(s)) → ` +
    `${String(on.false_green_rate)} (ON, ${String(on.runs)} run(s)), delta ${delta >= 0 ? '+' : ''}${String(delta)}`;

  if (null === noise) {
    return {
      ok: true,
      measured: true,
      outcome: 'inconclusive',
      reason:
        `${rates}. Run-to-run noise is UNOBSERVED — at least two runs per arm are needed to see it, ` +
        `and this pass has ${String(off.runs)}/${String(on.runs)}${null === requested ? '' : ` (requested ${String(requested)})`}. ` +
        `A single run per arm cannot separate a real effect from the loop's own variance, so this ` +
        `number is reported and NOT concluded on. Re-run with --runs 3 or more.`,
      delta,
      noise,
    };
  }

  if (delta > noise) {
    return {
      ok: false,
      measured: true,
      outcome: 'regressed',
      reason:
        `INTENT+CONTEXT MADE VERIFICATION WORSE: ${rates}, which exceeds the observed run-to-run ` +
        `spread of ${String(noise)}. The agent called more things done that ground truth says were ` +
        `broken with the feature on than with it off. That is the one result this gate exists to ` +
        `refuse to pass quietly.`,
      delta,
      noise,
    };
  }

  if (delta < -noise) {
    return {
      ok: true,
      measured: true,
      outcome: 'improved',
      reason: `${rates} — a fall larger than the observed run-to-run spread of ${String(noise)}.`,
      delta,
      noise,
    };
  }

  return {
    ok: true,
    measured: true,
    outcome: 'inconclusive',
    reason:
      `${rates}, which is inside the observed run-to-run spread of ${String(noise)}. Nothing has ` +
      `been shown either way — do not quote this as an effect.`,
    delta,
    noise,
  };
}
