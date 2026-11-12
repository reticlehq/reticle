/**
 * Check a run's final answer against a value read from the app when the grade runs. Pure.
 *
 * A fixed answer string goes stale when the data changes. Here the expected answer is the output of
 * a declared source (a database query, an endpoint), read at grade time. A source with no rows means
 * that the task cannot be done, and the answer must be one of the `none` words (default `N/A`).
 *
 * Match kinds. Text is folded first: Unicode normal form, lower case, spacing, quotes and a final
 * full stop.
 * - `exact`: the answer is the one expected value. With more than one row, it is `set`.
 * - `number`: the answer is one number, and nothing else. `$`, `%` and digit-group commas are
 *   removed. It equals the first value within 0.005.
 * - `set`: the answer is a list, split on commas, semicolons and new lines, or also on " and ". It
 *   holds each expected value one time and nothing more. Order is not checked.
 * - `includes`: the answer contains each expected value. A long answer that names every record
 *   also passes, so use it only where the answer cannot list all choices.
 */
import { z } from 'zod';
import { StateSourceSchema } from '../compare/outside/state-sources.js';

export const AnswerMatch = {
  EXACT: 'exact',
  NUMBER: 'number',
  SET: 'set',
  INCLUDES: 'includes',
} as const;
export type AnswerMatch = (typeof AnswerMatch)[keyof typeof AnswerMatch];

/** The default answer for a task that cannot be done. */
export const DEFAULT_NONE = 'N/A';
/** Two numbers closer than this are equal: money has two decimals. */
const NUMBER_TOLERANCE = 0.005;

export const AnswerSpecSchema = z.strictObject({
  source: StateSourceSchema,
  match: z
    .enum([AnswerMatch.EXACT, AnswerMatch.NUMBER, AnswerMatch.SET, AnswerMatch.INCLUDES])
    .default(AnswerMatch.EXACT),
  none: z.array(z.string().min(1)).min(1).default([DEFAULT_NONE]),
});
export type AnswerSpec = z.infer<typeof AnswerSpecSchema>;

/** The `--expect` file of `reticle grade judge`. */
export const ExpectSchema = z.strictObject({
  answer: AnswerSpecSchema,
});

export interface AnswerCheck {
  ok: boolean;
  /** The expected answer, as text. */
  expected: string;
  /** Why the answer did not match. */
  reason?: string;
}

const COLUMN_BREAK = /\t/g;
const LIST_BREAK = /\s*[,;\n]\s*/;
const LIST_BREAK_AND = /\s*(?:[,;\n]|\band\b)\s*/;
const NUMBER_NOISE = /[$%\s]|,(?=\d{3}\b)/g;
const NUMBER_ONLY = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;

export function foldText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\.$/, '')
    .trim();
}

/** The number the text is, or undefined when it is not exactly one number. */
function numberOf(text: string): number | undefined {
  const bare = foldText(text).replace(NUMBER_NOISE, '');
  return NUMBER_ONLY.test(bare) ? Number(bare) : undefined;
}

const items = (text: string, breaks: RegExp): string[] =>
  text
    .split(breaks)
    .map(foldText)
    .filter((item) => '' !== item);

/** A list split on commas, or also on "and": a value such as "Black and White Tee" keeps its "and". */
const sameList = (values: readonly string[], answer: string): boolean =>
  sameSet(values, items(answer, LIST_BREAK)) || sameSet(values, items(answer, LIST_BREAK_AND));

function sameSet(expected: readonly string[], got: readonly string[]): boolean {
  if (expected.length !== got.length) {
    return false;
  }
  const left = [...got];
  return expected.every((value) => {
    const at = left.indexOf(value);
    if (at < 0) {
      return false;
    }
    left.splice(at, 1);
    return true;
  });
}

/** Check `answer` against the rows the answer source gave at grade time. */
export function checkAnswer(
  rows: readonly string[],
  answer: string | undefined,
  spec: Pick<AnswerSpec, 'match' | 'none'>,
): AnswerCheck {
  const values = rows.map((row) => foldText(row.replace(COLUMN_BREAK, ' '))).filter((v) => v);
  const expected = 0 === values.length ? (spec.none[0] ?? DEFAULT_NONE) : values.join(', ');
  if (answer === undefined) {
    return { ok: false, expected, reason: 'no answer was given' };
  }
  const got = foldText(answer);
  if (0 === values.length) {
    const ok = spec.none.some((word) => foldText(word) === got);
    return ok ? { ok, expected } : { ok, expected, reason: 'the task cannot be done' };
  }
  let ok: boolean;
  switch (spec.match) {
    case AnswerMatch.NUMBER: {
      const want = numberOf(values[0] ?? '');
      const have = numberOf(answer);
      ok = want !== undefined && have !== undefined && Math.abs(want - have) < NUMBER_TOLERANCE;
      break;
    }
    case AnswerMatch.INCLUDES:
      ok = values.every((value) => got.includes(value));
      break;
    case AnswerMatch.SET:
      ok = sameList(values, answer);
      break;
    case AnswerMatch.EXACT:
      ok = 1 === values.length ? values[0] === got : sameList(values, answer);
      break;
  }
  return ok ? { ok, expected } : { ok, expected, reason: `the answer is not ${expected}` };
}
