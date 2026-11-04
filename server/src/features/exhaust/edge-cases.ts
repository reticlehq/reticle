/**
 * Edge cases for the explorer to drive: the inputs and the interaction orders where behavioural
 * bugs live.
 *
 * The explorer types one ordinary value into each field and activates each control once, in the
 * order the page lists them. That proves the happy path and nothing else. A form that accepts
 * "   " as a name, keeps 11 in a field whose maximum is 10, or creates two orders on a double click
 * fails on a value or an order nobody tried. This module lists those values and sequences.
 *
 * Pure and deterministic: the same field, control and clock give the same list in the same order.
 * Every list is bounded, and the most telling items come first, so a small budget still tries them.
 * A sequence says nothing about what a correct result is; `invariants.ts` judges the pages it leaves.
 */

import type { Step } from './explorer.js';

// ── Edge-case values for one field ──────────────────────────────────────────────────────────────

/** What a field takes, as far as its type, input mode, role and name say. */
export const FieldKind = {
  TEXT: 'text',
  NUMBER: 'number',
  EMAIL: 'email',
  DATE: 'date',
  TIME: 'time',
  URL: 'url',
  TEL: 'tel',
} as const;
export type FieldKind = (typeof FieldKind)[keyof typeof FieldKind];

/** Why a value is an edge case. The report shows this beside the value. */
export const EdgeLabel = {
  EMPTY: 'empty',
  EMPTY_REQUIRED: 'empty in a required field',
  WHITESPACE: 'whitespace only',
  PADDED: 'leading and trailing spaces',
  OVER_MAX_LENGTH: 'one character over maxlength',
  UNDER_MIN_LENGTH: 'one character under minlength',
  LONG_TEXT: 'long text, no maxlength set',
  UNICODE: 'emoji and non-Latin script',
  RTL: 'right-to-left text',
  MARKUP: 'markup characters',
  BREAKS_PATTERN: 'does not match the pattern',
  DUPLICATE: 'duplicate of a value the app already holds',
  ZERO: 'zero',
  NEGATIVE: 'negative number',
  BELOW_MIN: 'one below min',
  ABOVE_MAX: 'one above max',
  VERY_LARGE: 'very large number',
  DECIMAL: 'decimal number',
  WRONG_FORMAT: 'wrong format for the field type',
  PAST_DATE: 'date in the past',
  FUTURE_DATE: 'date far in the future',
  IMPOSSIBLE_DATE: 'date that does not exist',
  MIDNIGHT: 'midnight',
  IMPOSSIBLE_TIME: 'time that does not exist',
} as const;
export type EdgeLabel = (typeof EdgeLabel)[keyof typeof EdgeLabel];

/** One field, with what the snapshot or the DOM gives about it. Every attribute is optional. */
export interface FieldSpec {
  role: string;
  name?: string;
  type?: string;
  inputMode?: string;
  value?: string;
  min?: string;
  max?: string;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  required?: boolean;
  /** Values the app already holds for this field, such as the rows of a list. */
  existing?: readonly string[];
}

export interface EdgeValue {
  value: string;
  label: EdgeLabel;
}

/** The default bound. A field gets at most this many values. */
export const MAX_EDGE_VALUES = 16;
/** How many existing values are reused as duplicates. */
const MAX_DUPLICATES = 2;
/** Length of the long text for a field with no maxlength. */
const LONG_TEXT_LENGTH = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
const FUTURE_YEARS = 100;

const SAMPLE: Record<FieldKind, string> = {
  [FieldKind.TEXT]: 'a',
  [FieldKind.NUMBER]: '1',
  [FieldKind.EMAIL]: 'a@example.com',
  [FieldKind.DATE]: '2026-01-01',
  [FieldKind.TIME]: '12:00',
  [FieldKind.URL]: 'https://example.com',
  [FieldKind.TEL]: '5550100',
};

const WRONG_FORMAT: Partial<Record<FieldKind, string>> = {
  [FieldKind.NUMBER]: 'abc',
  [FieldKind.EMAIL]: 'not-an-email',
  [FieldKind.URL]: 'not a url',
  [FieldKind.TEL]: 'abc',
  [FieldKind.TIME]: 'noon',
};

const TYPE_KIND: Record<string, FieldKind> = {
  number: FieldKind.NUMBER,
  range: FieldKind.NUMBER,
  email: FieldKind.EMAIL,
  date: FieldKind.DATE,
  'datetime-local': FieldKind.DATE,
  month: FieldKind.DATE,
  time: FieldKind.TIME,
  url: FieldKind.URL,
  tel: FieldKind.TEL,
};

const INPUT_MODE_KIND: Record<string, FieldKind> = {
  numeric: FieldKind.NUMBER,
  decimal: FieldKind.NUMBER,
  email: FieldKind.EMAIL,
  url: FieldKind.URL,
  tel: FieldKind.TEL,
};

/**
 * Words in a field's name that say what it takes, for a field whose type the snapshot does not give.
 * ponytail: English names only; a field in another language falls back to text, which still gets
 * every generic edge value.
 */
const NAME_KIND: readonly [RegExp, FieldKind][] = [
  [/\be-?mail\b/i, FieldKind.EMAIL],
  [/\b(?:date|birthday|dob)\b/i, FieldKind.DATE],
  [/\btime\b/i, FieldKind.TIME],
  [/\b(?:url|website|link)\b/i, FieldKind.URL],
  [/\b(?:phone|tel|mobile)\b/i, FieldKind.TEL],
  [/\b(?:amount|quantity|qty|price|age|count|number)\b/i, FieldKind.NUMBER],
];

export function fieldKindOf(
  spec: Pick<FieldSpec, 'role' | 'type' | 'inputMode' | 'name'>,
): FieldKind {
  const byType = TYPE_KIND[spec.type ?? ''];
  if (byType !== undefined) {
    return byType;
  }
  const byMode = INPUT_MODE_KIND[spec.inputMode ?? ''];
  if (byMode !== undefined) {
    return byMode;
  }
  if (spec.role.startsWith('spinbutton') || spec.role.startsWith('slider')) {
    return FieldKind.NUMBER;
  }
  const byName = NAME_KIND.find(([words]) => words.test(spec.name ?? ''));
  return byName === undefined ? FieldKind.TEXT : byName[1];
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function numberValues(spec: FieldSpec): EdgeValue[] {
  const out: EdgeValue[] = [];
  const min = Number(spec.min);
  const max = Number(spec.max);
  if (spec.min !== undefined && Number.isFinite(min)) {
    out.push({ value: String(min - 1), label: EdgeLabel.BELOW_MIN });
  }
  if (spec.max !== undefined && Number.isFinite(max)) {
    out.push({ value: String(max + 1), label: EdgeLabel.ABOVE_MAX });
  }
  out.push(
    { value: '0', label: EdgeLabel.ZERO },
    { value: '-1', label: EdgeLabel.NEGATIVE },
    { value: '999999999999999999999', label: EdgeLabel.VERY_LARGE },
    { value: '0.1', label: EdgeLabel.DECIMAL },
  );
  return out;
}

function dateValues(now: number): EdgeValue[] {
  const today = new Date(now);
  const future = new Date(now);
  future.setUTCFullYear(today.getUTCFullYear() + FUTURE_YEARS);
  const [year = '', month = '', day = ''] = isoDay(now).split('-');
  return [
    { value: isoDay(now - DAY_MS), label: EdgeLabel.PAST_DATE },
    { value: isoDay(future.getTime()), label: EdgeLabel.FUTURE_DATE },
    { value: `${year}-02-30`, label: EdgeLabel.IMPOSSIBLE_DATE },
    { value: `${day}/${month}/${year}`, label: EdgeLabel.WRONG_FORMAT },
  ];
}

const TIME_VALUES: readonly EdgeValue[] = [
  { value: '00:00', label: EdgeLabel.MIDNIGHT },
  { value: '25:61', label: EdgeLabel.IMPOSSIBLE_TIME },
];

/** A value that the pattern refuses, or none when the pattern is invalid or accepts it. */
function breaksPattern(pattern: string | undefined): EdgeValue[] {
  if (pattern === undefined) {
    return [];
  }
  const candidate = '!!!';
  try {
    return new RegExp(`^(?:${pattern})$`, 'v').test(candidate)
      ? []
      : [{ value: candidate, label: EdgeLabel.BREAKS_PATTERN }];
  } catch {
    return [];
  }
}

function lengthValues(spec: FieldSpec, kind: FieldKind): EdgeValue[] {
  const out: EdgeValue[] = [];
  if (spec.maxLength !== undefined && spec.maxLength >= 0) {
    out.push({ value: 'x'.repeat(spec.maxLength + 1), label: EdgeLabel.OVER_MAX_LENGTH });
  } else if (FieldKind.TEXT === kind) {
    out.push({ value: 'x'.repeat(LONG_TEXT_LENGTH), label: EdgeLabel.LONG_TEXT });
  }
  if (spec.minLength !== undefined && spec.minLength > 1) {
    out.push({ value: 'x'.repeat(spec.minLength - 1), label: EdgeLabel.UNDER_MIN_LENGTH });
  }
  return out;
}

/** Values for any field that holds text: script, direction and markup. */
const TEXT_VALUES: readonly EdgeValue[] = [
  { value: 'Zoë 李 😀', label: EdgeLabel.UNICODE },
  { value: 'مرحبا بالعالم', label: EdgeLabel.RTL },
  { value: '<b>&amp;</b>', label: EdgeLabel.MARKUP },
];

function kindValues(spec: FieldSpec, kind: FieldKind, now: number): EdgeValue[] {
  const wrong = WRONG_FORMAT[kind];
  const wrongValue = wrong === undefined ? [] : [{ value: wrong, label: EdgeLabel.WRONG_FORMAT }];
  if (FieldKind.NUMBER === kind) {
    return [...numberValues(spec), ...wrongValue];
  }
  if (FieldKind.DATE === kind) {
    return dateValues(now);
  }
  if (FieldKind.TIME === kind) {
    return [...TIME_VALUES, ...wrongValue];
  }
  if (FieldKind.TEXT === kind) {
    return [...TEXT_VALUES];
  }
  return wrongValue;
}

/**
 * The edge-case values for a field, most telling first, with no value twice, at most `max`.
 * `now` is the injected clock: past and future dates are relative to it.
 */
export function edgeInputs(
  spec: FieldSpec,
  opts: { now: () => number; max?: number },
): EdgeValue[] {
  const kind = fieldKindOf(spec);
  const base = spec.value !== undefined && spec.value.trim().length > 0 ? spec.value : SAMPLE[kind];
  const candidates: EdgeValue[] = [
    { value: '', label: true === spec.required ? EdgeLabel.EMPTY_REQUIRED : EdgeLabel.EMPTY },
    { value: '   ', label: EdgeLabel.WHITESPACE },
    ...kindValues(spec, kind, opts.now()),
    ...lengthValues(spec, kind),
    ...breaksPattern(spec.pattern),
    ...(spec.existing ?? [])
      .slice(0, MAX_DUPLICATES)
      .map((value) => ({ value, label: EdgeLabel.DUPLICATE })),
    { value: ` ${base} `, label: EdgeLabel.PADDED },
  ];
  const seen = new Set<string>();
  const out: EdgeValue[] = [];
  for (const candidate of candidates) {
    if (!seen.has(candidate.value)) {
      seen.add(candidate.value);
      out.push(candidate);
    }
  }
  return out.slice(0, opts.max ?? MAX_EDGE_VALUES);
}

// ── Interaction edge cases for one control ─────────────────────────────────────────────────────

/** The actions a sequence uses. `click` and `fill` are the explorer's own; the rest are new. */
export const EdgeAction = {
  CLICK: 'click',
  FILL: 'fill',
  /** The browser's back. */
  BACK: 'back',
  /** A full reload of the current page. */
  RELOAD: 'reload',
  /** Wait until the page settles. Two steps with no settle between them run back to back. */
  SETTLE: 'settle',
} as const;
export type EdgeAction = (typeof EdgeAction)[keyof typeof EdgeAction];

export type EdgeStep =
  Step | { action: typeof EdgeAction.BACK | typeof EdgeAction.RELOAD | typeof EdgeAction.SETTLE };

export const EdgeInteraction = {
  DOUBLE_ACTIVATION: 'double-activation',
  RAPID_REPEAT: 'rapid-repeat',
  ACT_THEN_BACK: 'act-then-back',
  ACT_THEN_RELOAD: 'act-then-reload',
  SUBMIT_TWICE: 'submit-twice',
  SUBMIT_BEFORE_FILL: 'submit-before-fill',
  OUT_OF_ORDER: 'out-of-order',
} as const;
export type EdgeInteraction = (typeof EdgeInteraction)[keyof typeof EdgeInteraction];

export interface EdgeSequence {
  kind: EdgeInteraction;
  /** The control the sequence is about. */
  target: string;
  steps: EdgeStep[];
}

/** How many activations a rapid repeat sends back to back. */
export const RAPID_REPEAT = 5;
/** The default bound on sequences for one control. */
export const MAX_EDGE_SEQUENCES = 8;

/**
 * A control that sends a form or commits a change, by its name.
 * ponytail: English names only. A submit the name does not show still gets double activation and
 * rapid repeat, which drive the same clicks without the fills.
 */
const SUBMIT_NAME =
  /^button\s+"[^"]*\b(?:submit|save|send|create|add|pay|confirm|place order|sign (?:in|up)|log ?in|register|apply|update|post|checkout|continue)\b/i;

export function looksLikeSubmit(control: string): boolean {
  return SUBMIT_NAME.test(control);
}

const click = (key: string): EdgeStep => ({ action: EdgeAction.CLICK, key });

/** A step in words, for the action sequence on a finding. */
export function describeStep(step: EdgeStep): string {
  if ('key' in step) {
    return step.action === EdgeAction.FILL
      ? `fill ${step.key} with ${JSON.stringify(step.value ?? '')}`
      : `click ${step.key}`;
  }
  return step.action;
}

/**
 * The edge sequences for `control`. `order` is the page's controls in document order; `fills` are
 * the steps that fill the form the control belongs to, when it has one.
 */
export function edgeInteractions(
  input: { control: string; order: readonly string[]; fills?: readonly Step[] },
  opts: { max?: number } = {},
): EdgeSequence[] {
  const { control } = input;
  const fills = [...(input.fills ?? [])];
  const at = (kind: EdgeInteraction, steps: EdgeStep[]): EdgeSequence => ({
    kind,
    target: control,
    steps,
  });
  const out: EdgeSequence[] = [
    at(EdgeInteraction.DOUBLE_ACTIVATION, [click(control), click(control)]),
    at(
      EdgeInteraction.RAPID_REPEAT,
      Array.from({ length: RAPID_REPEAT }, () => click(control)),
    ),
    at(EdgeInteraction.ACT_THEN_BACK, [click(control), { action: EdgeAction.BACK }]),
    at(EdgeInteraction.ACT_THEN_RELOAD, [click(control), { action: EdgeAction.RELOAD }]),
  ];
  if (looksLikeSubmit(control)) {
    out.push(
      at(EdgeInteraction.SUBMIT_TWICE, [
        ...fills,
        click(control),
        { action: EdgeAction.SETTLE },
        click(control),
      ]),
    );
    if (fills.length > 0) {
      out.push(at(EdgeInteraction.SUBMIT_BEFORE_FILL, [click(control), ...fills, click(control)]));
    }
  }
  const index = input.order.indexOf(control);
  const before = index > 0 ? input.order[index - 1] : undefined;
  if (before !== undefined && before !== control) {
    out.push(at(EdgeInteraction.OUT_OF_ORDER, [click(control), click(before)]));
  }
  return out.slice(0, opts.max ?? MAX_EDGE_SEQUENCES);
}
