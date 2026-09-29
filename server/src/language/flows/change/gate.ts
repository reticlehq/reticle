/**
 * The completion gate — exits non-zero unless passing artifacts cover the flows affected by the changed
 * files. This is what makes verification unavoidable: an agent that edits a covered file cannot "finish"
 * without re-verifying. Flaky flows are quarantined — surfaced, never gate-blocking — because one
 * unexplained flake that blocks a merge destroys trust in the red. Pure decision; the CLI computes the
 * inputs (git diff → affected → run artifacts + flake ledger) and maps `pass` to the exit code.
 */

/** A flow whose assertions were WEAKENED since its last passing run. */
interface DowngradedFlow {
  flow: string;
  /** Step indices whose mustHold dropped from a consequence to presence-only. */
  steps: number[];
}

interface GateInput {
  /** Flows that must be covered (from the affected index over the changed files). */
  affected: readonly string[];
  /** Flows that have a passing verification artifact. */
  passing: readonly string[];
  /** Flows currently quarantined as flaky — excluded from blocking. */
  flaky?: readonly string[];
  /** Flows whose assertion tier was downgraded since the last passing run (anti-reward-hacking). */
  downgraded?: readonly DowngradedFlow[];
  /** Flows that covered a changed file but no longer exist — coverage deleted rather than satisfied. */
  deleted?: readonly string[];
  /** Changed interactive components no saved flow touches — a change nothing has driven. */
  unflowed?: readonly string[];
  /** Coverage levels below the best they ever reached — something new appeared, nothing covered it. */
  coverageRegressed?: readonly { level: string; was: number; now: number }[];
  /** Changed files the browser loaded and never ran a function of. */
  unexecuted?: readonly string[];
}

interface GateResult {
  /** True when every affected, non-flaky flow has a passing artifact AND nothing was weakened/deleted. */
  pass: boolean;
  /** Affected flows with no passing artifact and not flaky — these block the gate. */
  uncovered: string[];
  /** Affected flows excluded only because they are quarantined flaky — surfaced, not blocking. */
  quarantined: string[];
  /** Assertion-tier downgrades — BLOCKING: a green bought by weakening the test is the gaming vector. */
  downgraded: DowngradedFlow[];
  /** Deleted flows that covered changed files — BLOCKING for the same reason. */
  deleted: string[];
  /** Changed interactive components no flow covers — BLOCKING: the change was never driven. */
  unflowed: string[];
  /** BLOCKING: the app grew something nothing has covered. */
  coverageRegressed: { level: string; was: number; now: number }[];
  /** BLOCKING: changed code that never ran in any drive. */
  unexecuted: string[];
}

export function gateDecision(input: GateInput): GateResult {
  const passing = new Set(input.passing);
  const flaky = new Set(input.flaky ?? []);
  const uncovered: string[] = [];
  const quarantined: string[] = [];
  for (const flow of input.affected) {
    if (passing.has(flow)) continue;
    if (flaky.has(flow)) quarantined.push(flow);
    else uncovered.push(flow);
  }
  // Downgrades and deleted coverage BLOCK. Flakiness is quarantined because a flake is not the agent's
  // doing; a weakened or deleted assertion is — surfacing it without blocking would leave the gate
  // trivially gameable, which is the exact failure this gate exists to prevent.
  const downgraded = [...(input.downgraded ?? [])];
  const deleted = [...(input.deleted ?? [])];
  const unflowed = [...(input.unflowed ?? [])];
  const coverageRegressed = [...(input.coverageRegressed ?? [])];
  const unexecuted = [...(input.unexecuted ?? [])];
  return {
    pass:
      0 === uncovered.length &&
      0 === downgraded.length &&
      0 === deleted.length &&
      0 === unflowed.length &&
      0 === coverageRegressed.length &&
      0 === unexecuted.length,
    uncovered,
    quarantined,
    downgraded,
    deleted,
    unflowed,
    coverageRegressed,
    unexecuted,
  };
}
