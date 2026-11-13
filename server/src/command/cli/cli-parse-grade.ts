/**
 * `reticle grade <snapshot|judge|tables|suggest> [flags]`: grade a finished run of an app from
 * snapshots of its stored data. The rules are in `@/features/grade/`.
 */
import {
  JSON_FLAG,
  missingOperand,
  missingValue,
  unknownArgument,
  type ParseError,
} from './cli-parse-grammar.js';

export const GRADE_COMMAND = 'grade';

export const GradeStep = {
  SNAPSHOT: 'snapshot',
  JUDGE: 'judge',
  TABLES: 'tables',
  SUGGEST: 'suggest',
} as const;
export type GradeStep = (typeof GradeStep)[keyof typeof GradeStep];

/** Each flag that takes a value, and the field it fills. */
const VALUE_FLAGS = {
  '--state': 'state',
  '--out': 'out',
  '--url': 'url',
  '--reference': 'reference',
  '--again': 'again',
  '--candidate': 'candidate',
  '--expect': 'expect',
  '--answer': 'answer',
  '--list': 'list',
  '--rows': 'rows',
  '--container': 'container',
  '--skip': 'skip',
} as const;
type GradeField = (typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS];

/** The flags each step needs, and the flags it also takes. */
const STEP_FLAGS: Record<GradeStep, { needs: GradeField[]; takes: GradeField[] }> = {
  [GradeStep.SNAPSHOT]: { needs: ['state', 'out'], takes: ['url'] },
  [GradeStep.JUDGE]: {
    needs: ['reference', 'again', 'candidate'],
    takes: ['expect', 'answer'],
  },
  [GradeStep.TABLES]: { needs: ['list', 'rows', 'out'], takes: ['container', 'skip'] },
  [GradeStep.SUGGEST]: { needs: ['state', 'reference', 'again', 'out'], takes: [] },
};

export type GradeArgs =
  | ({ kind: 'ok'; step: GradeStep; json: boolean } & Partial<Record<GradeField, string>>)
  | ParseError;

const isStep = (word: string | undefined): word is GradeStep =>
  Object.values(GradeStep).some((step) => step === word);
const isValueFlag = (arg: string): arg is keyof typeof VALUE_FLAGS => arg in VALUE_FLAGS;
const flagOf = (field: GradeField): string =>
  Object.keys(VALUE_FLAGS).find((f) => VALUE_FLAGS[f as keyof typeof VALUE_FLAGS] === field) ??
  field;

export function parseGradeArgs(args: readonly string[]): GradeArgs {
  const [step, ...rest] = args;
  if (!isStep(step)) {
    // A known flag before the step is a missing step, not an unknown flag.
    return step === undefined || isValueFlag(step) || JSON_FLAG === step
      ? missingOperand(GRADE_COMMAND, `a step first: ${Object.values(GradeStep).join(', ')}`)
      : unknownArgument(step);
  }
  const allowed = new Set<GradeField>([...STEP_FLAGS[step].needs, ...STEP_FLAGS[step].takes]);
  const values: Partial<Record<GradeField, string>> = {};
  let json = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? '';
    if (JSON_FLAG === arg && GradeStep.JUDGE === step) {
      json = true;
      continue;
    }
    if (!isValueFlag(arg) || !allowed.has(VALUE_FLAGS[arg])) {
      return unknownArgument(arg);
    }
    const value = rest[i + 1];
    // An answer may start with "--"; every other value may not.
    if (value === undefined || ('--answer' !== arg && value.startsWith('--'))) {
      return missingValue(arg);
    }
    values[VALUE_FLAGS[arg]] = value;
    i += 1;
  }
  const missing = STEP_FLAGS[step].needs.filter((field) => values[field] === undefined);
  if (missing.length > 0) {
    return missingOperand(`${GRADE_COMMAND} ${step}`, missing.map(flagOf).join(', '));
  }
  return { kind: 'ok', step, json, ...values };
}
