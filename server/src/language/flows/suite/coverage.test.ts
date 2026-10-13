import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeCoverage, flowCoverageReport, NO_FLOWS } from './coverage.js';
import { defaultAdvertisedNames } from '@/surface/tools/tool-surface.js';

describe('computeCoverage', () => {
  it('measures covered vs declared per dimension and names the gaps', () => {
    const declared = { testids: ['a', 'b', 'c', 'd'], signals: ['s1', 's2'], flows: ['checkout'] };
    const exercised = { testids: ['a', 'b'], signals: ['s1'], flows: ['checkout'] };
    const cov = computeCoverage(declared, exercised);
    expect(cov.testids).toEqual({ total: 4, covered: 2, pct: 50, uncovered: ['c', 'd'] });
    expect(cov.signals.pct).toBe(50);
    expect(cov.flows.pct).toBe(100);
    // overall = 4 covered / 7 declared ≈ 57
    expect(cov.overallPct).toBe(57);
  });

  /**
   * `covered: 0, total: 0, pct: 100` is a contradiction the caller has to notice unaided — and the
   * caller is an agent instructed to run the gate to learn whether its change is covered. A fresh
   * project, a broken install and a genuinely passing suite all produced the same green.
   *
   * Same shape as the honesty layer's `{ pct?: number; partial: boolean }`: pct is present only when
   * it was measured.
   */
  it('reports no percentage at all when nothing is declared — never 100', () => {
    const cov = computeCoverage(
      { testids: [], signals: [], flows: [] },
      { testids: [], signals: [], flows: [] },
    );
    expect(cov.overallPct, 'nothing was measured, so there is no percentage').toBeUndefined();
    expect(cov.testids.pct).toBeUndefined();
    expect(cov.testids.total).toBe(0);
  });

  it('ignores exercised members that were never declared', () => {
    const cov = computeCoverage(
      { testids: ['a'], signals: [], flows: [] },
      { testids: ['a', 'ghost'], signals: [], flows: [] },
    );
    expect(cov.testids).toEqual({ total: 1, covered: 1, pct: 100, uncovered: [] });
  });
});

/**
 * The gate's flow line. An empty suite is not a passing suite — the same rule `buildSuiteVerdict`
 * already applies to `reticle verify`, where zero flows reports `unverifiable` rather than
 * "all 0 flows pass".
 */
describe('flowCoverageReport', () => {
  it('refuses to look like a pass when no flows are recorded', () => {
    const cov = computeCoverage(
      { testids: [], signals: [], flows: [] },
      { testids: [], signals: [], flows: [] },
    );
    const report = flowCoverageReport(cov.flows);
    expect(report.pct, 'no flows means no percentage, not 100%').toBeUndefined();
    expect(report.outcome).toBe(NO_FLOWS);
    expect(report.note?.toLowerCase()).toContain('no flows recorded');
    // The RECORDING TOOL, not a `reticle record` CLI verb — this CLI does not dispatch one.
    expect(report.note).toContain('reticle_record');
  });

  it('reports the measured percentage when there is a suite', () => {
    const cov = computeCoverage(
      { testids: [], signals: [], flows: ['checkout', 'login'] },
      { testids: [], signals: [], flows: ['checkout'] },
    );
    const report = flowCoverageReport(cov.flows);
    expect(report).toEqual({ pct: 50, covered: 1, total: 2 });
  });
});

/**
 * Advice names only tools the reader can call (#1547).
 *
 * `reticle gate` with no flows, `verify affected` and the empty suite said "record one with
 * reticle_record, then reticle_flow_save", and the no-session advice said "reticle_lease": none of
 * them is on the default surface, so an agent looked for the tool, did not find it, and stopped.
 * Every `reticle_*` name in these messages is either advertised by default or reached through
 * `reticle_run { tool: "…" }`, which every surface advertises.
 */
describe('setup advice names only tools on the default surface', () => {
  const ADVICE_FILES = [
    'src/language/flows/suite/coverage.ts',
    'src/language/flows/affected-tools.ts',
    'src/language/flows/decision.ts',
    'src/portal/session/no-session-next-action.ts',
  ];
  const TOOL = /\breticle_[a-z_]+\b/g;
  const HATCHED = /tool:\s*"$/;

  /** The text of every string and template literal in a source file, comment lines excluded. */
  function literalsOf(path: string): string[] {
    const code = readFileSync(join(process.cwd(), path), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
      .join('\n');
    const LITERAL = /'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"/g;
    return [...code.matchAll(LITERAL)].map((m) => m[0].slice(1, -1).replace(/\\"/g, '"'));
  }

  it.each(ADVICE_FILES)('%s', (path) => {
    const callable = new Set(defaultAdvertisedNames());
    const unreachable: string[] = [];
    for (const text of literalsOf(path)) {
      for (const match of text.matchAll(TOOL)) {
        const before = text.slice(0, match.index);
        if (!callable.has(match[0]) && !HATCHED.test(before)) unreachable.push(match[0]);
      }
    }
    expect(unreachable, 'named bare, but not on the default surface').toEqual([]);
  });
});
