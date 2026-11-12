import { describe, expect, it } from 'vitest';
import { AnswerMatch, AnswerSpecSchema, checkAnswer, DEFAULT_NONE } from './grade-answer.js';

const spec = (match: AnswerMatch, none = [DEFAULT_NONE]) => ({ match, none });

describe('checkAnswer', () => {
  it('takes the same text with other case, spacing, quotes and a final full stop', () => {
    expect(checkAnswer(['Jane Doe'], '  "jane  doe." ', spec(AnswerMatch.EXACT)).ok).toBe(true);
    expect(checkAnswer(['Jane Doe'], 'Jane', spec(AnswerMatch.EXACT))).toMatchObject({
      ok: false,
      expected: 'jane doe',
    });
  });

  it('takes a number with a currency sign and digit-group commas, and only one number', () => {
    expect(checkAnswer(['1234.50'], '$1,234.5', spec(AnswerMatch.NUMBER)).ok).toBe(true);
    expect(checkAnswer(['3'], '3 orders', spec(AnswerMatch.NUMBER)).ok).toBe(false);
    expect(checkAnswer(['3'], '3 or 4', spec(AnswerMatch.NUMBER)).ok).toBe(false);
    expect(checkAnswer(['3'], '4', spec(AnswerMatch.NUMBER)).ok).toBe(false);
  });

  it('takes a list in any order, and refuses a list with one more or one less', () => {
    const rows = ['Bag', 'Hat'];
    expect(checkAnswer(rows, 'hat, bag', spec(AnswerMatch.SET)).ok).toBe(true);
    expect(checkAnswer(rows, 'Hat and Bag', spec(AnswerMatch.SET)).ok).toBe(true);
    expect(checkAnswer(rows, 'Hat, Bag, Shoe', spec(AnswerMatch.SET)).ok).toBe(false);
    expect(checkAnswer(rows, 'Hat', spec(AnswerMatch.SET)).ok).toBe(false);
  });

  it('keeps the "and" in a value of a list', () => {
    const rows = ['Black and White Tee', 'Hat'];
    expect(checkAnswer(rows, 'Hat, Black and White Tee', spec(AnswerMatch.SET)).ok).toBe(true);
  });

  it('checks an exact answer with more than one row as a list', () => {
    expect(checkAnswer(['Bag', 'Hat'], 'Hat; Bag', spec(AnswerMatch.EXACT)).ok).toBe(true);
  });

  it('takes an answer that contains each expected value', () => {
    expect(checkAnswer(['Hat'], 'The best seller is the Hat', spec(AnswerMatch.INCLUDES)).ok).toBe(
      true,
    );
  });

  it('expects a none word when the source has no rows: the task cannot be done', () => {
    expect(checkAnswer([], 'n/a', spec(AnswerMatch.EXACT)).ok).toBe(true);
    expect(checkAnswer([], '0', spec(AnswerMatch.NUMBER))).toMatchObject({
      ok: false,
      expected: DEFAULT_NONE,
    });
    expect(checkAnswer([], 'cannot be done', spec(AnswerMatch.EXACT, ['Cannot be done'])).ok).toBe(
      true,
    );
  });

  it('fails with no answer, also for a task that cannot be done', () => {
    expect(checkAnswer([], undefined, spec(AnswerMatch.EXACT)).ok).toBe(false);
  });

  it('reads a row of more than one column as one value', () => {
    expect(checkAnswer(['Jane\tDoe'], 'Jane Doe', spec(AnswerMatch.EXACT)).ok).toBe(true);
  });
});

describe('AnswerSpecSchema', () => {
  it('defaults to exact, with N/A for a task that cannot be done', () => {
    const parsed = AnswerSpecSchema.parse({
      source: { kind: 'command', label: 'answer', command: 'q' },
    });
    expect(parsed).toMatchObject({ match: AnswerMatch.EXACT, none: [DEFAULT_NONE] });
  });
});
