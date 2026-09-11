/**
 * The four numbers the intent+context arms are compared on, as pure functions over a normalized
 * transcript. Separate from the runner so every decision here is unit-tested; the runner is a
 * fixture-driving script with top-level await and cannot be imported from a test — the same split
 * `coverage-floor.mjs` and `pass-artifact.mjs` already use.
 *
 * ## The transcript shape
 *
 * One flat array, in the order the run produced it. Two kinds of step:
 *
 *   { kind: 'call',  tool, target, ok, text }   a tool call and what came back
 *   { kind: 'claim', text }                     an assistant message
 *
 * `target` is the canonical form of the call's arguments (see `canonicalTarget`), so "the same tool
 * against the same thing" is a string comparison and not a judgement.
 *
 * ## Why the grader is not a tautology
 *
 * The lesson is `network-timeout`: it graded on a regex the request URL itself satisfied, so every
 * tool got a free true positive on a scenario that was never live. Three properties keep that from
 * recurring here:
 *
 * 1. **Ground truth is source-level, never textual.** Whether the app is broken comes from
 *    `inject.mjs` having applied a source edit, not from anything in the transcript. No string the
 *    agent or the app emits can move it.
 * 2. **A catch requires ground truth to say the defect is LIVE.** `stepsToCorrect` scores a catch
 *    only when `injected` is true. The identical transcript on a clean app scores `caught: false`
 *    and is counted as a FALSE ALARM instead — that is the negative control, and it is a test.
 * 3. **A tautological symptom regex is visible in the output.** If the regex matched regardless of
 *    the defect, the control (not-injected) runs would carry a non-zero false-alarm count, which is
 *    reported beside every catch rate rather than discarded. A grader that cannot be wrong on the
 *    control is a grader nobody should believe.
 *
 * Everything here returns `null` for "not measured" and never 0. Absent is not zero — recording a
 * missing arm as a zero is the exact defect `tool-coverage.mjs` exists to prevent.
 */

/**
 * Tools that only READ. A re-query is only interesting for these: re-issuing an action is a second
 * action, not a redundant look.
 *
 * Matched on the tool-name suffix rather than an enumerated list, so a tool added tomorrow is
 * classified without editing this file. `reticle_wait_for` is deliberately NOT read-only: it blocks
 * on a future condition rather than re-fetching an established fact, so re-issuing it is not
 * redundancy. `reticle_network_mock` is excluded by the same suffix rule — it installs a stub.
 */
const READ_ONLY_TOOL =
  /(query|snapshot|observe|state|network|console|inspect|context|list|session|sessions|tools|coverage|project)$/i;

/** A claim that the whole task is settled — the protocol the agent loop asks the model to emit. */
const GLOBAL_VERDICT = /VERDICT:\s*(PASS|FAIL)/i;

/** Settles a claim as "this is broken". Checked FIRST — "does not render" carries no clean word. */
const BROKEN =
  /VERDICT:\s*FAIL|\b(broken|fails?|failed|missing|never|not render|does not|doesn't|didn't)\b/i;

/** Settles a claim as "this is fine". */
const CLEAN =
  /VERDICT:\s*PASS|\b(works|working|renders|rendered|healthy|fine|correct|verified|as expected|no issues?)\b/i;

/** Is this tool a read? */
export function isReadOnly(tool) {
  return READ_ONLY_TOOL.test(String(tool ?? ''));
}

/**
 * The canonical form of a call's arguments, so "same target" is decidable by string equality.
 *
 * Keys sorted, `sessionId` dropped (it names the tab, not the subject). Deliberately shallow-stable
 * rather than clever: two calls that differ only in key order are the same call.
 */
export function canonicalTarget(args) {
  if (null === args || 'object' !== typeof args) return JSON.stringify(args ?? null);
  const entries = Object.entries(args)
    .filter(([key]) => 'sessionId' !== key)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/** 'broken' | 'clean' | null — what a message settles, if anything. */
export function claimPolarity(text) {
  const s = String(text ?? '');
  if (BROKEN.test(s)) return 'broken';
  if (CLEAN.test(s)) return 'clean';
  return null;
}

/**
 * Metric 2 — RE-QUERY RATE.
 *
 * A read-only call is a re-query when the run ALREADY established that exact fact: the same tool,
 * against the same canonical target, returned successfully at an earlier step. Mechanical on
 * purpose — no judgement about whether the agent "should have remembered".
 *
 * `rate` is null when the run made no read-only calls at all: a rate over an empty denominator is
 * not zero, it is unmeasured.
 */
export function reQueryRate(steps) {
  const seen = new Set();
  let reads = 0;
  let repeats = 0;
  for (const step of steps ?? []) {
    if ('call' !== step?.kind || !isReadOnly(step.tool)) continue;
    reads += 1;
    const key = `${String(step.tool)}::${String(step.target)}`;
    if (seen.has(key)) repeats += 1;
    else if (false !== step.ok) seen.add(key);
  }
  return { reads, repeats, rate: 0 === reads ? null : +(repeats / reads).toFixed(3) };
}

/**
 * Metric 3 — STEPS-TO-CORRECT.
 *
 * The number of TOOL CALLS made before the agent first says the true thing about the injected
 * defect. `symptom` is the scenario's symptom regex; it is matched against assistant text, and it is
 * only ever a CATCH when `injected` is true. On a clean app the same match is a false alarm.
 *
 * Returns `{ caught, calls, falseAlarm }`. `calls` is null whenever there is no catch — including on
 * a clean run, where "steps to correctly identify a defect that does not exist" is not a number.
 */
export function stepsToCorrect(steps, { injected, symptom } = {}) {
  let calls = 0;
  for (const step of steps ?? []) {
    if ('call' === step?.kind) {
      calls += 1;
      continue;
    }
    if ('claim' !== step?.kind || !symptom.test(String(step.text ?? ''))) continue;
    // Property 2 above: ground truth decides whether this is a catch, the text only says WHEN.
    if (true !== injected) return { caught: false, calls: null, falseAlarm: true };
    return { caught: true, calls, falseAlarm: false };
  }
  return { caught: false, calls: null, falseAlarm: false };
}

/**
 * Metric 1 — FALSE GREENS, per run.
 *
 * A claim is counted when it settles the whole task (`VERDICT:`) or when it settles the SUBJECT the
 * defect lives in — scoped by `subject`, because "the Overview looks fine" is a true statement about
 * a part of the app the defect never touched, and counting it would inflate both arms with noise.
 *
 * A false green is a claim of `clean` while ground truth says the defect is live.
 */
export function falseGreens(steps, { injected, subject } = {}) {
  let claims = 0;
  let wrong = 0;
  for (const step of steps ?? []) {
    if ('claim' !== step?.kind) continue;
    const text = String(step.text ?? '');
    if (!GLOBAL_VERDICT.test(text) && !subject.test(text)) continue;
    const polarity = claimPolarity(text);
    if (null === polarity) continue;
    claims += 1;
    if (true === injected && 'clean' === polarity) wrong += 1;
  }
  return { claims, wrong, rate: 0 === claims ? null : +(wrong / claims).toFixed(3) };
}

/**
 * Metric 4 — PROPAGATION DEPTH.
 *
 * An UNGROUNDED claim is one the run had no fresh evidence for: no read-only call happened between
 * the most recent acting call and the claim. That is Reticle's whole thesis stated as an arithmetic
 * condition — the agent settled something that nothing it did proved.
 *
 * Depth is how many steps follow that claim before the run either SELF-CORRECTS (a later claim of
 * the opposite polarity that IS grounded) or ends. A wrong early belief that the run keeps building
 * on is the long-running failure this metric exists to see.
 *
 * `depth` is null when no ungrounded claim occurred — there is nothing to have propagated.
 */
export function propagationDepth(steps) {
  const all = steps ?? [];
  let observedSinceAction = false;
  let firstIndex = null;
  let firstPolarity = null;
  for (let i = 0; i < all.length; i += 1) {
    const step = all[i];
    if ('call' === step?.kind) {
      observedSinceAction = isReadOnly(step.tool);
      continue;
    }
    if ('claim' !== step?.kind) continue;
    const polarity = claimPolarity(step.text);
    if (null === polarity || observedSinceAction) continue;
    firstIndex = i;
    firstPolarity = polarity;
    break;
  }
  if (null === firstIndex) {
    return { firstUngroundedStep: null, depth: null, selfCorrected: false };
  }

  let grounded = false;
  for (let i = firstIndex + 1; i < all.length; i += 1) {
    const step = all[i];
    if ('call' === step?.kind) {
      grounded = isReadOnly(step.tool);
      continue;
    }
    if ('claim' !== step?.kind) continue;
    const polarity = claimPolarity(step.text);
    if (null === polarity || polarity === firstPolarity || !grounded) continue;
    return { firstUngroundedStep: firstIndex, depth: i - firstIndex - 1, selfCorrected: true };
  }
  return {
    firstUngroundedStep: firstIndex,
    depth: all.length - firstIndex - 1,
    selfCorrected: false,
  };
}

/** Every metric for one run. `injected`/`subject`/`symptom` come from the scenario, never the transcript. */
export function scoreRun(steps, scenario) {
  return {
    false_green: falseGreens(steps, scenario),
    re_query: reQueryRate(steps),
    steps_to_correct: stepsToCorrect(steps, scenario),
    propagation: propagationDepth(steps),
  };
}

/** The spread of a list of numbers, ignoring nulls. Null when fewer than two values survived. */
export function spread(values) {
  const numbers = (values ?? []).filter((v) => 'number' === typeof v && Number.isFinite(v));
  if (numbers.length < 2) return null;
  return +(Math.max(...numbers) - Math.min(...numbers)).toFixed(3);
}

const mean = (xs) =>
  0 === xs.length ? null : +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);

/**
 * Fold per-run scores into one arm.
 *
 * An arm with no runs is `present: false` and carries NO rates — not zeros. A zero here would say
 * "this arm was measured and scored nothing", which is a different and much more flattering claim
 * than "this arm did not run".
 */
export function summarizeArm(runs) {
  const rows = runs ?? [];
  if (0 === rows.length) return { present: false, runs: 0 };
  const claims = rows.reduce((n, r) => n + r.false_green.claims, 0);
  const wrong = rows.reduce((n, r) => n + r.false_green.wrong, 0);
  const perRun = rows.map((r) => r.false_green.rate);
  const caught = rows.map((r) => r.steps_to_correct.calls).filter((v) => null !== v);
  const depths = rows.map((r) => r.propagation.depth).filter((v) => null !== v);
  const reads = rows.reduce((n, r) => n + r.re_query.reads, 0);
  const repeats = rows.reduce((n, r) => n + r.re_query.repeats, 0);
  return {
    present: true,
    runs: rows.length,
    false_green_claims: claims,
    false_greens: wrong,
    false_green_rate: 0 === claims ? null : +(wrong / claims).toFixed(3),
    false_green_rate_per_run: perRun,
    false_green_spread: spread(perRun),
    re_query_reads: reads,
    re_query_repeats: repeats,
    re_query_rate: 0 === reads ? null : +(repeats / reads).toFixed(3),
    steps_to_correct_mean: mean(caught),
    caught_runs: caught.length,
    false_alarm_runs: rows.filter((r) => r.steps_to_correct.falseAlarm).length,
    propagation_depth_mean: mean(depths),
    self_corrected_runs: rows.filter((r) => r.propagation.selfCorrected).length,
  };
}
