import { describe, expect, it } from 'vitest';
import { parseGradeArgs } from './cli-parse-grade.js';

describe('parseGradeArgs', () => {
  it('reads a judge with an answer that starts with dashes', () => {
    expect(
      parseGradeArgs([
        'judge',
        '--reference',
        'r.json',
        '--again',
        'a.json',
        '--candidate',
        'c.json',
        '--answer',
        '-3',
        '--json',
      ]),
    ).toEqual({
      kind: 'ok',
      step: 'judge',
      json: true,
      reference: 'r.json',
      again: 'a.json',
      candidate: 'c.json',
      answer: '-3',
    });
  });

  it('names each flag a step needs and does not have', () => {
    expect(parseGradeArgs(['snapshot', '--url', 'http://x/'])).toEqual({
      kind: 'error',
      message: 'grade snapshot needs --state, --out',
    });
  });

  it('refuses a flag another step takes, and an unknown step', () => {
    expect(parseGradeArgs(['snapshot', '--answer', 'x'])).toMatchObject({ kind: 'error' });
    expect(parseGradeArgs(['run'])).toMatchObject({ kind: 'error' });
    expect(parseGradeArgs([])).toMatchObject({ kind: 'error' });
    expect(parseGradeArgs(['--state', 'x'])).toEqual({
      kind: 'error',
      message: 'grade needs a step first: snapshot, judge, tables, suggest',
    });
  });

  it('refuses a flag with no value', () => {
    expect(parseGradeArgs(['snapshot', '--state', '--out', 'x'])).toEqual({
      kind: 'error',
      message: '--state needs a value',
    });
  });
});
