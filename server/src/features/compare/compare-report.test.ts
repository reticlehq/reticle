import { describe, expect, it } from 'vitest';
import { DifferenceKind } from './compare-diff.js';
import { compareExit, compareJson, compareLines } from './compare-report.js';
import type { CompareResult } from './compare-run.js';

const base: CompareResult = {
  differences: [],
  compared: 4,
  unstable: 0,
  ignored: 0,
  journeys: 2,
  explored: { states: 2, actions: 3, frontier: 0, budgetExhausted: false },
};
const urls = { reference: 'http://ref', candidate: 'http://cand' };

describe('compare report', () => {
  it('says no difference and exits 0 when the builds agree', () => {
    expect(compareLines(urls, base).join('\n')).toContain('No difference');
    expect(compareExit(base)).toBe(0);
  });

  it('exits 1, and says nothing was proved, when no step was compared', () => {
    const none = { ...base, compared: 0 };
    expect(compareExit(none)).toBe(1);
    expect(compareLines(urls, none).join('\n')).toContain('Nothing was compared');
  });

  it('prints each difference with its actions, and - and + lines, and exits 1', () => {
    const result: CompareResult = {
      ...base,
      differences: [
        {
          id: 'abc123abc123',
          kind: DifferenceKind.CHANGED,
          actions: ['click button "Open"'],
          removed: ['hello'],
          added: ['goodbye'],
          seen: 2,
        },
        {
          id: 'def456def456',
          kind: DifferenceKind.UNREACHED,
          actions: ['click button "Close"'],
          removed: [],
          added: [],
          seen: 1,
        },
      ],
    };
    const text = compareLines(urls, result).join('\n');
    expect(text).toContain('abc123abc123');
    expect(text).toContain('  - hello');
    expect(text).toContain('  + goodbye');
    expect(text).toContain('could not do');
    expect(compareExit(result)).toBe(1);
    const json = compareJson(urls, result);
    expect(json).toMatchObject({ identical: false, reference: 'http://ref' });
    expect(json.differences.map((d) => d.id)).toEqual(['abc123abc123', 'def456def456']);
  });
});
