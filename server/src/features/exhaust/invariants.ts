/**
 * Behaviour checks that need no reference answer.
 *
 * A test needs someone to write down what the app should do. These do not: each one compares the app
 * with itself — the page before an action with the page after its undo, the first press with the
 * second, the value sent with the value shown, one run with an identical run. Each is a pure
 * function over observations the explorer already takes, and each returns findings with the steps
 * that show the fault and, when the app gives it, the source line of the element.
 *
 * A check that cannot decide returns nothing. A false finding costs more than a missed one, so every
 * check below names the case it lets pass on purpose.
 */

import { BehaviourFindingKind } from '@reticlehq/core';
import { describeStep, type EdgeStep } from './edge-cases.js';
import type { ExploredWrite } from './explorer.js';
import type { FailureBranches } from './failure-branches.js';
import type { BehaviourFinding } from './ledger.js';

/** The rule each check holds the app to, in words, for the report. */
export const Invariant = {
  UNDO_RESTORES: 'undo or cancel returns the previous page',
  REPEAT_IS_STABLE: 'a repeated action does not change state again',
  RELOAD_KEEPS: 'a saved value is still shown after reload',
  SHOWN_IS_SENT: 'the value shown after a write is the value the write sent',
  DETERMINISTIC: 'two identical drives give the same result',
  FAILURE_HANDLED: 'no success over a failed write',
  NO_FAULT: 'an edge case gets an answer, not an error',
  RESPONDS: 'a control that is pressed does something',
} as const;
export type Invariant = (typeof Invariant)[keyof typeof Invariant];

/** A page as the explorer looks at it: the route and the interactive snapshot tree. */
export interface PageObservation {
  route?: string;
  tree: string;
}

/** A write an action sent, with the server's answer. */
export interface WriteObservation {
  /** `METHOD /path`, as `writeKeyOf` spells it. */
  key: string;
  status?: number;
  /** The response body, as text. */
  response?: string;
}

/** What every check takes besides its observations. */
interface Context {
  steps: readonly EdgeStep[];
  /** The element's source. Read it from an action result with `sourceOf` (surface/tools). */
  source?: { file: string; line: number };
}

const REF = /\s*\(ref=e\d+\)/g;
/** Focus moves with every action and is not part of what the page shows. */
const FOCUSED = /\[focused\]|,focused\b|\bfocused,/g;
const DIGITS = /\d+/g;
/** How many changed lines a finding quotes. */
const MAX_QUOTED = 3;
/** Writes that create something new each time they are sent. PUT and DELETE are idempotent. */
const CREATES = 'POST ';
const OK_MIN = 200;
const OK_MAX = 299;

function visibleLines(page: PageObservation): string[] {
  const lines = page.tree
    .split('\n')
    .map((line) =>
      line
        .replace(REF, '')
        .replace(FOCUSED, '')
        .replace(/\s*\[\]/g, '')
        .trimEnd(),
    )
    .filter((line) => line.trim().length > 0);
  return [`route ${page.route ?? ''}`, ...lines];
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((line, i) => line === b[i]);

/** The two pages show the same thing: refs and focus aside, every line and the route are equal. */
export const samePage = (a: PageObservation, b: PageObservation): boolean =>
  same(visibleLines(a), visibleLines(b));

/** The lines one page has and the other does not, quoted for a finding. */
function difference(before: readonly string[], after: readonly string[]): string {
  const gone = before.filter((line) => !after.includes(line)).slice(0, MAX_QUOTED);
  const added = after.filter((line) => !before.includes(line)).slice(0, MAX_QUOTED);
  const parts = [
    ...(gone.length > 0 ? [`missing: ${gone.map((l) => l.trim()).join('; ')}`] : []),
    ...(added.length > 0 ? [`new: ${added.map((l) => l.trim()).join('; ')}`] : []),
  ];
  return parts.length > 0 ? parts.join(' | ') : 'the lines are in a different order';
}

function finding(
  kind: BehaviourFindingKind,
  invariant: Invariant,
  detail: string,
  ctx: Context,
  extraSteps: readonly string[] = [],
): BehaviourFinding {
  const src = ctx.source;
  return {
    kind,
    invariant,
    detail,
    sequence: [...ctx.steps.map(describeStep), ...extraSteps],
    ...(src === undefined ? {} : { source: `${src.file}:${String(src.line)}` }),
  };
}

/**
 * (a) After an action and its undo or cancel, the page shows what it showed before the action.
 * `after` is the page after the undo. Refs and focus are ignored; every other line counts.
 */
export function checkUndo(
  input: { before: PageObservation; after: PageObservation } & Context,
): BehaviourFinding[] {
  const before = visibleLines(input.before);
  const after = visibleLines(input.after);
  if (same(before, after)) {
    return [];
  }
  return [
    finding(
      BehaviourFindingKind.UNDO_NOT_RESTORED,
      Invariant.UNDO_RESTORES,
      `the page after undo is not the page before the action (${difference(before, after)})`,
      input,
    ),
  ];
}

const isOk = (w: WriteObservation): boolean =>
  w.status !== undefined && w.status >= OK_MIN && w.status <= OK_MAX;

/**
 * (b) An action pressed twice. Two faults:
 * - the page after the second press is the page after the first, but the second press sent a POST
 *   the server accepted and answered differently: it created a second thing the screen hides;
 * - the first press changed nothing on the page and the second changed it.
 * Lets pass: a toggle or a counter (each press shows its own change), and a POST the server answers
 * the same way twice (an upsert).
 */
export function checkRepeat(
  input: {
    before: PageObservation;
    afterFirst: PageObservation;
    afterSecond: PageObservation;
    firstWrites?: readonly WriteObservation[];
    secondWrites?: readonly WriteObservation[];
  } & Context,
): BehaviourFinding[] {
  const before = visibleLines(input.before);
  const first = visibleLines(input.afterFirst);
  const second = visibleLines(input.afterSecond);
  if (same(first, second)) {
    const firstWrites = input.firstWrites ?? [];
    const hidden = (input.secondWrites ?? []).find(
      (w) =>
        w.key.startsWith(CREATES) &&
        isOk(w) &&
        !firstWrites.some((f) => f.key === w.key && f.response === w.response),
    );
    if (hidden === undefined) {
      return [];
    }
    return [
      finding(
        BehaviourFindingKind.REPEAT_CHANGED_STATE,
        Invariant.REPEAT_IS_STABLE,
        `the second press sent ${hidden.key} and the server accepted it with a new answer, but the page shows the same result as after the first press`,
        input,
      ),
    ];
  }
  if (!same(before, first)) {
    return [];
  }
  return [
    finding(
      BehaviourFindingKind.REPEAT_CHANGED_STATE,
      Invariant.REPEAT_IS_STABLE,
      `the first press changed nothing and the second press changed the page (${difference(first, second)})`,
      input,
    ),
  ];
}

/**
 * (c) A value the app said it saved is still shown after a reload. Lets pass: an empty value (there
 * is nothing to look for), and an app that said the value was not saved.
 */
export function checkReloadKeeps(
  input: { value: string; afterReload: PageObservation; appSaidNotSaved?: boolean } & Context,
): BehaviourFinding[] {
  const value = input.value.trim();
  if (
    0 === value.length ||
    true === input.appSaidNotSaved ||
    input.afterReload.tree.includes(value)
  ) {
    return [];
  }
  return [
    finding(
      BehaviourFindingKind.LOST_AFTER_RELOAD,
      Invariant.RELOAD_KEEPS,
      `the app saved ${JSON.stringify(value)}, and after a reload the page does not show it`,
      input,
      ['reload'],
    ),
  ];
}

/** Padding, case and digit grouping are presentation, not a different value. */
function normalized(value: string): string {
  const text = value.trim().replace(/\s+/g, ' ').toLowerCase();
  return /^-?[\d,]+(?:\.\d+)?$/.test(text) ? text.replace(/,/g, '') : text;
}

/**
 * (d) The value a field shows after a write is the value the write request sent for it. Lets pass:
 * a field that shows nothing (it was cleared or closed), and differences of padding, case and digit
 * grouping.
 */
export function checkShownMatchesSent(
  input: { field: string; sent: string; shown: string | undefined } & Context,
): BehaviourFinding[] {
  if (input.shown === undefined || 0 === input.shown.trim().length) {
    return [];
  }
  if (normalized(input.shown) === normalized(input.sent)) {
    return [];
  }
  return [
    finding(
      BehaviourFindingKind.SHOWN_DIFFERS_FROM_SENT,
      Invariant.SHOWN_IS_SENT,
      `${input.field} shows ${JSON.stringify(input.shown)}, but the write sent ${JSON.stringify(input.sent)}`,
      input,
    ),
  ];
}

/**
 * (e) Two identical drives from a fresh page show the same page. A difference is reported as
 * intermittent: one run does not say which result is the fault.
 *
 * ponytail: every digit is masked before the compare, so a clock, an id or a relative time does not
 * read as a different result. The ceiling: two runs that differ only in a number ("3 items" against
 * "4 items") pass. Mask only time-like and id-like tokens if that proves too loose.
 */
export function checkDeterministic(
  input: { first: PageObservation; second: PageObservation } & Context,
): BehaviourFinding[] {
  const shape = (page: PageObservation): string[] =>
    visibleLines(page).map((line) => line.replace(DIGITS, '#'));
  const first = shape(input.first);
  const second = shape(input.second);
  if (same(first, second)) {
    return [];
  }
  return [
    {
      ...finding(
        BehaviourFindingKind.INTERMITTENT_RESULT,
        Invariant.DETERMINISTIC,
        `two identical drives showed different pages (${difference(first, second)})`,
        input,
      ),
      intermittent: true,
    },
  ];
}

/**
 * (f) No success over a failed write. The judgement is `driveFailureBranches`'s own; this only gives
 * each unhandled write the steps that fire it, so it reads like every other finding.
 */
export function failureFindings(
  branches: FailureBranches,
  writes: readonly ExploredWrite[],
): BehaviourFinding[] {
  return branches.unhandled.map((u) => ({
    kind: BehaviourFindingKind.FAILURE_UNHANDLED,
    invariant: Invariant.FAILURE_HANDLED,
    detail: u.detail,
    sequence: [
      ...(writes.find((w) => w.key === u.key)?.path ?? []).map(describeStep),
      `fail ${u.key}`,
    ],
  }));
}
