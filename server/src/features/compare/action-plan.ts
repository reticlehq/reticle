/**
 * The action plan `reticle compare` drives on each build. Pure: it reads trees and returns steps.
 *
 * The plan is made on the reference, breadth first, with no model and no settings:
 * - the start page, and a wait on the start page;
 * - every single action on every control: click each button, tab, checkbox and option; fill each
 *   text field with two values chosen by the shape of its value, one edge value of that shape, and
 *   the values the app's scripts compare the field's name with (`value-dictionary.ts`); select each
 *   option of a combobox;
 * - each click again, followed by a wait, so behaviour on a timer can show. The wait stays in the
 *   plan only when the reference showed delayed activity there: a call still pending, a page that
 *   kept changing while it settled, or a change during the wait;
 * - each single action again under each option of each combobox (a mode, a variant);
 * - after each sequence, one level deeper into the controls its last action made appear (a menu, a
 *   dialog): controls that were not on the page before that action;
 * - on a page with two or more fields: fill every field with its own value, then press each button,
 *   also a button that is disabled until the fields are filled.
 *   Only this shows a build that takes the start time for the end time.
 *
 * A control is targeted by its test id when it has one, else by its role and name. Controls with the
 * same target are numbered in page order, so "fill every field" fills eight fields, not one field
 * eight times. Every sequence starts from a fresh load of the start page.
 */

import { magicValues, type ValueDictionary } from './outside/value-dictionary.js';

/** A control on the page, by identity. `nth` counts the controls with the same identity before it. */
export interface Target {
  testid?: string;
  role?: string;
  name?: string;
  nth: number;
}

export type PlanStep =
  | { action: 'click'; target: Target }
  | { action: 'fill'; target: Target; value: string }
  | { action: 'select'; target: Target; value: string }
  | { action: 'wait'; ms: number }
  | { action: 'fillall'; fields: readonly { target: Target; value: string }[] };

export type Sequence = readonly PlanStep[];

export const ControlKind = { CLICK: 'click', FILL: 'fill', SELECT: 'select' } as const;
export type ControlKind = (typeof ControlKind)[keyof typeof ControlKind];

export interface PlanControl {
  kind: ControlKind;
  target: Target;
  ref?: string;
  /** The field's value now. Empty for a control that is not a field. */
  value: string;
  /** The option labels of a combobox. */
  options: string[];
  disabled: boolean;
}

/** The most sequences in one plan. Each costs one fresh load on every build. */
export const MAX_SEQUENCES = 220;
/** A sequence this long is not probed for controls that appeared. */
const MAX_DEPTH = 3;
/** The wait after a click: a slideshow advances, a countdown ends, a delivery settles. */
export const WAIT_AFTER_CLICK_MS = 4000;
const MS_PER_S = 1000;

const CONTROL_LINE =
  /^(\s*)- (button|checkbox|switch|radio|combobox|textbox|spinbutton|menuitem|menuitemcheckbox|tab|option|slider)\b(?: "([^"]*)")?(.*)$/;
const TESTID = /\[testid=([^\]]+)\]/;
const REF = /\(ref=(e\d+)\)/;
const VALUE = /\[value="([^"]*)"\]/;
const DISABLED = /\[(?:[a-z]+,)*disabled(?:,[a-z]+)*\]/;
const COMBOBOX = 'combobox';
const OPTION = 'option';
const FIELD_ROLES: ReadonlySet<string> = new Set(['textbox', 'spinbutton']);

const TIME = /^\d{1,2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}|^\d{1,2}\/\d{1,2}\/\d{4}$/;
const NUMBER = /^-?\d+(\.\d+)?$/;
/** Long text with markup characters and a non-ASCII mark: a build that breaks only on such input. */
export const EDGE_TEXT = `${'W'.repeat(120)} <b>&amp;</b> "q" ✓`;
/** Two ordinary values of a shape, then one edge value: the last minute, a leap day, a negative. */
const TIME_VALUES = ['09:15', '17:45', '23:59'] as const;
const DATE_VALUES = ['2024-02-03', '2024-11-28', '2024-02-29'] as const;
const NUMBER_VALUES = ['0', '7', '-1'] as const;
const TEXT_VALUES = ['', 'Reticle 42', EDGE_TEXT] as const;
const FIELD_TEXT = 'Reticle';
const HOURS_PER_DAY = 24;

/** The identity of a target, without its number. */
const identityOf = (t: Target): string =>
  t.testid === undefined ? `${t.role ?? ''} "${t.name ?? ''}"` : `[testid=${t.testid}]`;

/** The identity of a target, with its number. */
export const targetKey = (t: Target): string => `${identityOf(t)}#${String(t.nth)}`;

/** The target as a person reads it: `button "Save"`, `[testid=save]`, `button "Open" #2`. */
export const targetLabel = (t: Target): string =>
  0 === t.nth ? identityOf(t) : `${identityOf(t)} #${String(t.nth + 1)}`;

/** The controls of a tree, numbered by page order. Options are kept on their combobox. */
export function planControls(tree: string): PlanControl[] {
  const out: PlanControl[] = [];
  const seen = new Map<string, number>();
  let combo: { indent: number; control: PlanControl } | undefined;
  for (const line of tree.split('\n')) {
    const m = CONTROL_LINE.exec(line);
    if (null === m) {
      continue;
    }
    const indent = (m[1] ?? '').length;
    const role = m[2] ?? '';
    const name = m[3] ?? '';
    const rest = m[4] ?? '';
    if (OPTION === role && combo !== undefined && indent > combo.indent) {
      combo.control.options.push(name);
      continue;
    }
    combo = undefined;
    if (OPTION === role) {
      continue;
    }
    const testid = TESTID.exec(rest)?.[1];
    const base = testid === undefined ? { role, name } : { testid };
    const identity = identityOf({ ...base, nth: 0 });
    const nth = seen.get(identity) ?? 0;
    seen.set(identity, nth + 1);
    const ref = REF.exec(rest)?.[1];
    let kind: ControlKind = ControlKind.CLICK;
    if (COMBOBOX === role) {
      kind = ControlKind.SELECT;
    } else if (FIELD_ROLES.has(role)) {
      kind = ControlKind.FILL;
    }
    const control: PlanControl = {
      kind,
      target: { ...base, nth },
      ...(ref === undefined ? {} : { ref }),
      value: VALUE.exec(rest)?.[1] ?? '',
      options: [],
      disabled: DISABLED.test(rest),
    };
    out.push(control);
    if (ControlKind.SELECT === kind) {
      combo = { indent, control };
    }
  }
  return out;
}

/** The ref of `target` on this tree, or undefined when the tree has no such control. */
export function refFor(tree: string, target: Target): string | undefined {
  const key = targetKey(target);
  return planControls(tree).find((c) => targetKey(c.target) === key)?.ref;
}

/**
 * Values for a field, by the shape of its value: two that differ from it and from each other, so a
 * build that mixes up two fields shows a difference, and one edge value of that shape.
 */
export function valuesFor(value: string): readonly string[] {
  if (TIME.test(value)) {
    return TIME_VALUES;
  }
  if (DATE.test(value)) {
    return DATE_VALUES;
  }
  if (NUMBER.test(value)) {
    return NUMBER_VALUES;
  }
  return TEXT_VALUES;
}

const EMPTY_DICTIONARY: ValueDictionary = new Map();

/** The name the app's scripts would compare a field with: its accessible name, else its test id. */
const fieldName = (c: PlanControl): string => c.target.name ?? c.target.testid ?? '';

/** The single actions on one control. None on a disabled control. */
export function actionsOf(
  control: PlanControl,
  dictionary: ValueDictionary = EMPTY_DICTIONARY,
): PlanStep[] {
  if (control.disabled) {
    return [];
  }
  const { target } = control;
  if (ControlKind.SELECT === control.kind) {
    return control.options.map((value) => ({ action: ControlKind.SELECT, target, value }));
  }
  if (ControlKind.FILL === control.kind) {
    const values = new Set([
      ...valuesFor(control.value),
      ...magicValues(dictionary, fieldName(control)),
    ]);
    return [...values].map((value) => ({ action: ControlKind.FILL, target, value }));
  }
  return [{ action: ControlKind.CLICK, target }];
}

/**
 * Field `index`'s own value in "fill every field": the first value the app compares it with, else an
 * ordinary value of its shape, where a time moves by one hour for each field.
 */
function ownValue(field: PlanControl, index: number, dictionary: ValueDictionary): string {
  const magic = magicValues(dictionary, fieldName(field))[0];
  if (magic !== undefined) {
    return magic;
  }
  const value = valuesFor(field.value)[index % 2] ?? '';
  if ('' === value) {
    return `${FIELD_TEXT} ${String(index + 1)}`;
  }
  const time = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (null === time) {
    return value;
  }
  const hour = (Number(time[1]) + index) % HOURS_PER_DAY;
  return `${String(hour).padStart(2, '0')}:${time[2] ?? ''}`;
}

export function stepLabel(step: PlanStep): string {
  switch (step.action) {
    case 'wait':
      return `wait ${String(step.ms / MS_PER_S)} s`;
    case 'fillall':
      return `fill every field (${step.fields.map((f) => `${targetLabel(f.target)}="${f.value}"`).join(', ')})`;
    case 'fill':
      return `fill ${targetLabel(step.target)} with "${step.value}"`;
    case 'select':
      return `select "${step.value}" in ${targetLabel(step.target)}`;
    case 'click':
      return `click ${targetLabel(step.target)}`;
  }
}

/** One key for one sequence, the same on every build. */
export const sequenceKey = (seq: Sequence): string => JSON.stringify(seq);

const targetOf = (step: PlanStep): string | undefined =>
  'target' in step ? targetKey(step.target) : undefined;

/** What a probe of one sequence saw. */
export interface Probe {
  /** The settled tree after the last step. */
  tree: string;
  /** For a sequence that ends in a wait: whether the reference showed delayed activity there. */
  active: boolean;
}

const endsInWait = (seq: Sequence): boolean => 'wait' === seq.at(-1)?.action;

/**
 * Make the plan on the reference. `probe` drives one sequence from a fresh load, or answers
 * undefined when a step could not be done.
 */
export async function buildPlan(
  startTree: string,
  probe: (seq: Sequence) => Promise<Probe | undefined>,
  dictionary: ValueDictionary = EMPTY_DICTIONARY,
): Promise<Sequence[]> {
  const start = planControls(startTree);
  const keysOf = (tree: string): Set<string> =>
    new Set(planControls(tree).map((c) => targetKey(c.target)));
  /** The controls on the page after each probed sequence, to tell what its next action added. */
  const before = new Map<string, Set<string>>([[sequenceKey([]), keysOf(startTree)]]);
  const steps = (c: PlanControl): PlanStep[] => actionsOf(c, dictionary);
  const singles = start.flatMap(steps);
  const modes = start.filter((c) => ControlKind.SELECT === c.kind).flatMap(steps);
  const wait: PlanStep = { action: 'wait', ms: WAIT_AFTER_CLICK_MS };
  const queue: Sequence[] = [
    [wait],
    ...singles.map((s) => [s]),
    ...singles.filter((s) => ControlKind.CLICK === s.action).map((s) => [s, wait]),
    ...modes.flatMap((m) => singles.filter((s) => targetOf(s) !== targetOf(m)).map((s) => [m, s])),
  ];
  const plan: Sequence[] = [[]];
  const seen = new Set([sequenceKey([])]);
  while (queue.length > 0 && plan.length < MAX_SEQUENCES) {
    const seq = queue.shift() ?? [];
    const key = sequenceKey(seq);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    // A wait is probed before it is planned: it stays only where the reference showed activity.
    const probed = seq.length < MAX_DEPTH || endsInWait(seq) ? await probe(seq) : undefined;
    if (endsInWait(seq) && true !== probed?.active) {
      continue;
    }
    plan.push(seq);
    if (seq.length >= MAX_DEPTH || probed === undefined) {
      continue;
    }
    before.set(key, keysOf(probed.tree));
    const all = planControls(probed.tree);
    const now = all.filter((c) => !c.disabled);
    const fields = now.filter((c) => ControlKind.FILL === c.kind);
    if (fields.length >= 2 && !seq.some((s) => 'fillall' === s.action)) {
      const fillall: PlanStep = {
        action: 'fillall',
        fields: fields.map((f, i) => ({ target: f.target, value: ownValue(f, i, dictionary) })),
      };
      queue.unshift([...seq, fillall]);
      // Also a disabled button: a submit is often disabled until the fields are filled.
      for (const button of all.filter((c) => ControlKind.CLICK === c.kind)) {
        queue.push([...seq, fillall, { action: ControlKind.CLICK, target: button.target }]);
      }
    }
    const parent = before.get(sequenceKey(seq.slice(0, -1))) ?? before.get(sequenceKey([]));
    for (const control of now.filter((c) => parent?.has(targetKey(c.target)) !== true)) {
      for (const step of steps(control)) {
        queue.push([...seq, step]);
      }
    }
  }
  return plan;
}

/**
 * The sequences to drive: those that are not the start of another planned sequence. The page is
 * read after every step of a run, so a run also reads each planned sequence it starts with.
 */
export function longestRuns(plan: readonly Sequence[]): Sequence[] {
  const starts = new Set<string>();
  for (const seq of plan) {
    for (let i = 0; i < seq.length; i += 1) {
      starts.add(sequenceKey(seq.slice(0, i)));
    }
  }
  return plan.filter((seq) => !starts.has(sequenceKey(seq)));
}
