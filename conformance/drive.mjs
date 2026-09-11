/**
 * Driving an implementation through the scenarios, and collecting what it said.
 *
 * The piece that was missing, and its absence was the honest gap at the bottom of the README: the
 * scenarios, the profiles and the scoring rules were all written and tested, and there was no way
 * to actually run them against anything. A suite that cannot run is not a suite that passes.
 *
 * ── THE CONTRACT INVERSION ──────────────────────────────────────────────────────────────────────
 * This suite cannot inject a defect into an application it does not own, and pretending otherwise
 * is how a portable conformance suite quietly becomes a test of one vendor's fixture.
 *
 * So YOU supply the subject. Ship a small application for your platform, answer one extra command
 * -- `x-conformance.plant` -- with a scenario id, and this drives your implementation against your
 * application and scores what it says. That is a real cost and it is the correct one: it is the
 * same cost the reference implementation's own fixture pays, and it is the only arrangement in
 * which this needs no code from us for a platform we have never seen.
 *
 * ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────────────────────────
 * Interpret. An implementation returns a verdict and a reason; this compares them to what the
 * scenario requires and records the answer. It never decides that a `no` was "close enough" to an
 * `unknown`, and it never retries a scenario until it passes. A suite that helps is a suite whose
 * scores mean nothing.
 */

import { Outcome, declarationMatchesHandshake, report } from './score.mjs';
import { SCENARIOS } from './scenarios/index.mjs';

/** The command an implementation answers to put its own application into a scenario's state. */
export const PLANT_COMMAND = 'x-conformance.plant';

/**
 * How long any single scenario may take before it is abandoned.
 *
 * A bound, not a measurement. The scoring here must never depend on how fast the machine is --
 * this project has watched duration assertions fail only under parallel CI load, which is the
 * least useful moment for a test to be wrong. Exceeded means ABSENT, never failed: a scenario that
 * timed out taught us nothing about the implementation.
 */
export const SCENARIO_TIMEOUT_MS = 60_000;

/** Did the implementation say what this scenario required? */
export function answersScenario(scenario, answer) {
  const want = scenario.mustProduce ?? {};
  if (scenario.neverProduce !== undefined && answer.verdict === scenario.neverProduce) return false;
  if (want.notVerdict !== undefined) return answer.verdict !== want.notVerdict;
  if (want.verdict !== undefined && answer.verdict !== want.verdict) return false;
  // The GROUND is compared when the scenario names one -- the deciding clause as a code, never
  // the sentence beside it. `no` alone is not enough for a scenario about a contradiction, since
  // a merely failed assertion returns `no` too; and comparing the prose would score an
  // implementation on this one's vocabulary.
  if (want.ground !== undefined && answer.ground !== want.ground) return false;
  return true;
}

/**
 * One scenario, start to finish.
 *
 * Every failure mode here resolves to ABSENT rather than FAILED, and the distinction is the point:
 * a plant that was refused, a transport that broke and a timeout all mean "we learned nothing",
 * and calling any of them a failure would blame the implementation for our inability to ask.
 */
export async function driveScenario(client, scenario, { timeoutMs = SCENARIO_TIMEOUT_MS } = {}) {
  const abandon = new Promise((resolve) =>
    setTimeout(() => resolve({ outcome: Outcome.ABSENT, note: 'timed out' }), timeoutMs),
  );
  const run = (async () => {
    let planted;
    try {
      planted = await client.command(PLANT_COMMAND, { scenario: scenario.id });
    } catch (error) {
      return { outcome: Outcome.ABSENT, note: `plant threw: ${String(error)}` };
    }
    if (planted?.planted !== true) {
      return { outcome: Outcome.ABSENT, note: planted?.reason ?? 'plant refused' };
    }
    let answer;
    try {
      answer = await client.verify(planted.claim);
    } catch (error) {
      return { outcome: Outcome.ABSENT, note: `verify threw: ${String(error)}` };
    }
    return {
      outcome: answersScenario(scenario, answer) ? Outcome.PASSED : Outcome.FAILED,
      answer,
    };
  })();
  return Promise.race([run, abandon]);
}

/**
 * Drive everything the registration claims, and report.
 *
 * The handshake is checked FIRST and a mismatch aborts before a single scenario runs. An
 * implementation claiming a channel it cannot observe would otherwise be offered scenarios it
 * should never have seen, and would fail them for the wrong reason -- or, worse, pass one by
 * accident and be credited for evidence it never had.
 */
export async function driveAll(client, registered, options = {}) {
  const handshake = await client.hello();
  const problems = declarationMatchesHandshake(registered, handshake);
  if (problems.length > 0) {
    return {
      name: registered.name,
      claimed: registered.profile,
      earned: undefined,
      rejected: problems,
      failed: [],
      couldNotBePlanted: [],
      neverAttempted: SCENARIOS.map((s) => s.id),
    };
  }

  const outcomes = {};
  const notes = {};
  // Sequential on purpose. Scenarios plant state into one shared application, so running two at
  // once would have them planting over each other -- and the failure that produces looks exactly
  // like the implementation being wrong.
  for (const scenario of SCENARIOS) {
    const result = await driveScenario(client, scenario, options);
    outcomes[scenario.id] = result.outcome;
    if (result.note !== undefined) notes[scenario.id] = result.note;
  }
  return { ...report(registered, outcomes), notes };
}
