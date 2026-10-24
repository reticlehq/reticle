// The pure half of the 2-agent parallel cell (parallel-agents.mjs): the URLs and the grade.
//
// Kept apart from the runner so the grade is unit-tested without a browser.

const AGENT_PARAM = 'bench-agent';
const BUG_PARAM = 'reticle-bug';

/** The URL agent `name` drives: its own, so each adapter pins its own tab. */
export function agentUrl(base, name, bug) {
  const u = new URL(base);
  u.searchParams.set(AGENT_PARAM, name);
  if (bug !== undefined) u.searchParams.set(BUG_PARAM, bug);
  return u.toString();
}

/** A replay that held: status ok, its success consequence held, no step drifted. */
const held = (r) => 'ok' === r.status && true === r.successOk && false === r.drifted;

/** A replay that caught the bug: its success consequence failed, and no step drifted. */
const caught = (r) => 'ok' !== r.status && false === r.successOk && false === r.drifted;

/**
 * Grade one run of the cell.
 *
 * `solo` is agent A's replay alone; `parallelA` and `parallelB` ran at the same time, B on the bugged
 * page. Correct: A holds both times and B is caught. Cross-talk: A held alone, but in parallel A
 * failed or B held, which is a verdict from the other tab. The overhead is A's parallel tokens
 * against A's solo tokens; null when either count is missing, never a guessed number.
 */
export function gradeParallelCell({ solo, parallelA, parallelB }) {
  const soloHeld = held(solo);
  const correct = soloHeld && held(parallelA) && caught(parallelB);
  const crossTalk = soloHeld && (!held(parallelA) || held(parallelB));
  const measured = 'number' === typeof solo.tokens && 'number' === typeof parallelA.tokens;
  const overhead =
    measured && 0 < solo.tokens
      ? Math.round(((parallelA.tokens - solo.tokens) / solo.tokens) * 100)
      : null;
  return { correct, cross_talk: crossTalk, parallel_token_overhead_pct: overhead };
}
