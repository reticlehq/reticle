import { describe, expect, it } from 'vitest';
import {
  CompareVerdict,
  DifferenceTag,
  invalidComparison,
  type BehaviourComparison,
  type BehaviourDifference,
} from './behaviour-diff.js';
import {
  COMPARE_SCHEMA_VERSION,
  CompareExit,
  MAX_DIFFERENCE_LINES,
  TOP_DIFFERENCES,
  compareExitCode,
  compareReportJson,
  compareReportLines,
} from './behaviour-report.js';
import { NOTHING_DROPPED } from './action-plan.js';

const urls = { reference: 'http://ref/', candidate: 'http://cand/' };
const timings = { plan: 12.3, reference: 20, candidate: 21.6, again: 19.9 };

const difference = (i: number, lines = 1): BehaviourDifference => ({
  id: `id${String(i)}`,
  kind: 'changed',
  actions: ['open the start page', `click button "B${String(i)}"`],
  removed: Array.from({ length: lines }, (_, n) => `old ${String(n)}`),
  added: [`new ${String(i)}`],
  seen: 1,
});

const result = (differences: BehaviourDifference[]): BehaviourComparison => ({
  verdict: differences.length > 0 ? CompareVerdict.DIFFERENT : CompareVerdict.SAME,
  sequences: 10,
  compared: 9,
  unstable: 1,
  referenceFailed: 2,
  ignored: 3,
  differences,
});

describe('compare report', () => {
  it('exits 0 for same, 1 for different and 2 for invalid', () => {
    expect(compareExitCode(result([]))).toBe(CompareExit.SAME);
    expect(compareExitCode(result([difference(1)]))).toBe(CompareExit.DIFFERENT);
    expect(compareExitCode(invalidComparison('session ended', 3))).toBe(CompareExit.INVALID);
    expect([CompareExit.SAME, CompareExit.DIFFERENT, CompareExit.INVALID]).toEqual([0, 1, 2]);
  });

  it('says what a plan cap left out, and nothing when it left out nothing', () => {
    const capped = { ...result([]), planDropped: { ...NOTHING_DROPPED, sequences: 4 } };
    expect(compareReportLines(urls, capped)).toContain(
      'The plan left out 4 items at its caps. --json "planDropped" gives the count for each cap.',
    );
    const full = { ...result([]), planDropped: NOTHING_DROPPED };
    expect(compareReportLines(urls, full).join('\n')).not.toContain('left out');
  });

  it('starts with the verdict, then the counts and the time for each build', () => {
    const lines = compareReportLines(urls, result([]), timings);
    expect(lines[0]).toMatch(/^SAME: /);
    expect(lines.join('\n')).toContain('10 sequences, 9 compared');
    expect(lines.join('\n')).toContain('2 the reference could not do');
    expect(lines.join('\n')).toContain('plan 12.3 s, reference 20 s, candidate 21.6 s');
  });

  it('prints the top differences with their steps and lines, and says what it left out', () => {
    const many = Array.from({ length: TOP_DIFFERENCES + 2 }, (_, i) =>
      difference(i, 0 === i ? MAX_DIFFERENCE_LINES + 2 : 1),
    );
    const text = compareReportLines(urls, result(many), timings).join('\n');
    expect(text.split('\n')[0]).toMatch(/^DIFFERENT: /);
    expect(text).toContain('2. click button "B0"');
    expect(text).toContain('- old 0');
    expect(text).toContain('+ new 1');
    expect(text).toContain('3 more lines');
    expect(text).toContain('2 more differences');
    expect(text).not.toContain('click button "B6"');
  });

  it('prints the invalid reason and, with a base, the tag and the score', () => {
    expect(compareReportLines(urls, invalidComparison('session ended', 3))[0]).toBe(
      'INVALID: session ended',
    );
    const scored: BehaviourComparison = {
      ...result([{ ...difference(1), tag: DifferenceTag.REGRESSION }]),
      score: { score: 0.5, targets: 2, matched: 1, kept: 0, changed: 0 },
    };
    const text = compareReportLines({ ...urls, base: 'http://base/' }, scored).join('\n');
    expect(text).toContain('score 0.50: 1 of 2 targets matched, 0 of 0 kept sequences changed');
    expect(text).toContain('[regression]');
  });

  it('gives the JSON a verified field, yes for same, no for different, unknown for invalid', () => {
    expect(compareReportJson(urls, result([])).verified).toBe('yes');
    expect(compareReportJson(urls, result([difference(1)])).verified).toBe('no');
    expect(compareReportJson(urls, invalidComparison('lost', 0)).verified).toBe('unknown');
  });

  it('writes every difference to the JSON, not only the top ones', () => {
    const many = Array.from({ length: TOP_DIFFERENCES + 2 }, (_, i) => difference(i));
    const json = compareReportJson(urls, result(many), timings);
    expect(json.schemaVersion).toBe(COMPARE_SCHEMA_VERSION);
    expect(json.verdict).toBe(CompareVerdict.DIFFERENT);
    expect(json.differences).toHaveLength(TOP_DIFFERENCES + 2);
    expect(json.seconds).toEqual(timings);
  });
});
