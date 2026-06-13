import { describe, expect, it } from 'vitest';
import { summarize, printSummary } from './summary.js';
import { TestStatus } from './constants.js';
import type { SpecResult } from './types.js';

const mixed: SpecResult[] = [
  { name: 'a', status: TestStatus.PASS, durationMs: 1 },
  { name: 'b', status: TestStatus.FAIL, durationMs: 2, error: 'boom' },
  { name: 'c', status: TestStatus.SKIP, durationMs: 0, skipReason: 'no real input' },
];

describe('summarize', () => {
  it('aggregate counts pass/fail/skip and overall ok', () => {
    expect(summarize(mixed)).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      ok: false,
    });
  });

  it('ok is true only when no spec failed', () => {
    const noFail: SpecResult[] = [
      { name: 'a', status: TestStatus.PASS, durationMs: 1 },
      { name: 'c', status: TestStatus.SKIP, durationMs: 0, skipReason: 'r' },
    ];
    expect(summarize(noFail).ok).toBe(true);
    expect(summarize(mixed).ok).toBe(false);
  });

  it('an empty result set is vacuously ok', () => {
    expect(summarize([])).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0, ok: true });
  });
});

describe('printSummary', () => {
  it('writes one line per spec plus a totals line to the injected sink', () => {
    const lines: string[] = [];
    printSummary(summarize(mixed), mixed, (l) => lines.push(l));
    // one line per spec + a footer
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('a');
    expect(lines[1]).toContain('b');
    expect(lines[2]).toContain('c');
    expect(lines[3]).toContain('1 passed');
    expect(lines[3]).toContain('1 failed');
    expect(lines[3]).toContain('1 skipped');
  });

  it('a skip line includes the reason', () => {
    const lines: string[] = [];
    printSummary(summarize(mixed), mixed, (l) => lines.push(l));
    const skipLine = lines.find((l) => l.includes('c'));
    expect(skipLine).toContain('no real input');
  });

  it('an empty run still prints a totals footer', () => {
    const lines: string[] = [];
    printSummary(summarize([]), [], (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('0 passed');
  });
});
