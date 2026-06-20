import { LOG_RESULT, type LogResult } from './presenter-log.js';

/** Running verdict counts the header tally shows — the testing score the human watches grow. */
export interface TallyCounts {
  passes: number;
  fails: number;
}

/** Count pass/fail verdicts across the run log. Pure — no DOM, unit-testable. */
export function countVerdicts(runLog: { result?: LogResult }[]): TallyCounts {
  let passes = 0;
  let fails = 0;
  for (const e of runLog) {
    if (e.result === LOG_RESULT.PASS) passes += 1;
    else if (e.result === LOG_RESULT.FAIL) fails += 1;
  }
  return { passes, fails };
}

/**
 * Paint the live verdict tally (✓N ✗M) into the header element from the run log. Hidden until the
 * first verdict lands; the side that just GREW gets a one-shot pop so the human FEELS the green (or
 * red) arrive — the score they watch climb as the agent verifies. Returns the new counts so the
 * caller tracks what grew for the next paint. Split out of presenter.ts to keep the controller lean.
 */
export function renderTally(
  el: HTMLElement | undefined,
  runLog: { result?: LogResult }[],
  prev: TallyCounts,
): TallyCounts {
  const next = countVerdicts(runLog);
  if (el === undefined) return next;
  if (next.passes === 0 && next.fails === 0) {
    el.setAttribute('hidden', '');
    return next;
  }
  const bumpPass = next.passes > prev.passes ? ' data-bump="1"' : '';
  const bumpFail = next.fails > prev.fails ? ' data-bump="1"' : '';
  const dimP = next.passes === 0 ? ' data-z="1"' : '';
  const dimF = next.fails === 0 ? ' data-z="1"' : '';
  el.removeAttribute('hidden');
  el.innerHTML =
    `<span class="iris-t-pass"${dimP}${bumpPass}>✓ ${String(next.passes)}</span>` +
    `<span class="iris-t-fail"${dimF}${bumpFail}>✗ ${String(next.fails)}</span>`;
  return next;
}
