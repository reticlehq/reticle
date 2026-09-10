import { LOG_RESULT, type LogResult } from './presenter-log.js';
import { PresenterIcon, PRESENTER_ICON_SIZE, hiIcon } from './presenter-icons.js';

/**
 * Paint the live verdict tally into a YouTube-style segmented pill (pass | fail).
 */
export function renderTally(
  el: HTMLElement | undefined,
  runLog: { result?: LogResult }[],
  prev: TallyCounts,
): TallyCounts {
  const next = countVerdicts(runLog);
  if (el === undefined) return next;
  if (0 === next.passes && 0 === next.fails) {
    el.setAttribute('hidden', '');
    el.replaceChildren();
    return next;
  }
  const doc = el.ownerDocument;
  el.removeAttribute('hidden');
  el.className = 'reticle-tally reticle-pill-group reticle-head-ctl';
  el.replaceChildren();

  const pass = doc.createElement('span');
  pass.className = 'reticle-t-pass reticle-pill-segment';
  if (0 === next.passes) pass.setAttribute('data-z', '1');
  if (next.passes > prev.passes) pass.setAttribute('data-bump', '1');
  pass.append(hiIcon(PresenterIcon.CHECK, PRESENTER_ICON_SIZE.TALLY));
  if (next.passes > 0) {
    const passN = doc.createElement('span');
    passN.className = 'reticle-pill-count';
    passN.textContent = String(next.passes);
    pass.append(passN);
  }

  const sep = doc.createElement('span');
  sep.className = 'reticle-pill-sep';
  sep.setAttribute('aria-hidden', 'true');

  const fail = doc.createElement('span');
  fail.className = 'reticle-t-fail reticle-pill-segment';
  if (0 === next.fails) fail.setAttribute('data-z', '1');
  if (next.fails > prev.fails) fail.setAttribute('data-bump', '1');
  fail.append(hiIcon(PresenterIcon.REMOVE, PRESENTER_ICON_SIZE.TALLY));
  if (next.fails > 0) {
    const failN = doc.createElement('span');
    failN.className = 'reticle-pill-count';
    failN.textContent = String(next.fails);
    fail.append(failN);
  }

  el.append(pass, sep, fail);
  return next;
}

/** Running verdict counts the header tally shows - the testing score the human watches grow. */
export interface TallyCounts {
  passes: number;
  fails: number;
}

/** Count pass/fail verdicts across the run log. Pure - no DOM, unit-testable. */
export function countVerdicts(runLog: { result?: LogResult }[]): TallyCounts {
  let passes = 0;
  let fails = 0;
  for (const e of runLog) {
    if (e.result === LOG_RESULT.PASS) passes += 1;
    else if (e.result === LOG_RESULT.FAIL) fails += 1;
  }
  return { passes, fails };
}
