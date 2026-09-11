import { describe, expect, it } from 'vitest';
import { measuredRealRegressions, toolsMeasured } from './tool-coverage.mjs';

/**
 * Zero and absent are different facts, and the analysis conflated them.
 *
 * The observation pass measures the tools named in BENCH_TOOLS; the analysis iterated a longer,
 * hard-coded list. A tool that never ran therefore got a full per-tool block of zeros — no true
 * positives, no tokens, and a denominator of every real-regression scenario — which reads as a tool
 * that looked at everything and caught nothing. That block lands in the baseline any "before" number
 * is later read from.
 *
 * It is worse than a zero, too: the denominator counted the scenario that is explicitly SKIPPED for
 * every tool that did run, because `undefined !== 'NOT MEASURED'`. The absent tools were graded over
 * a grid nobody was ever measured against.
 */

const cell = (verdict) => ({ verdict });

describe('toolsMeasured', () => {
  it('keeps only the tools that actually produced a row', () => {
    const rows = [{ tool: 'reticle' }, { tool: 'playwright' }, { tool: 'reticle' }];
    expect(toolsMeasured(rows, ['playwright', 'devtools', 'reticle', 'agentbrowser'])).toEqual([
      'playwright',
      'reticle',
    ]);
  });

  it('preserves the declared column order rather than order of appearance', () => {
    const rows = [{ tool: 'reticle' }, { tool: 'playwright' }];
    expect(toolsMeasured(rows, ['playwright', 'reticle'])).toEqual(['playwright', 'reticle']);
  });

  it('returns nothing when nothing ran', () => {
    expect(toolsMeasured([], ['playwright', 'reticle'])).toEqual([]);
  });
});

describe('measuredRealRegressions', () => {
  const perScenario = {
    'silent-dom': { expected_detect: true, by_tool: { reticle: cell('ok') } },
    'layout-shift': { expected_detect: true, by_tool: { reticle: cell('ok') } },
    'cross-component': { expected_detect: true, by_tool: { reticle: cell('NOT MEASURED') } },
    control: { expected_detect: false, by_tool: { reticle: cell('ok') } },
  };

  it('counts the real-regression scenarios a tool measured', () => {
    expect(measuredRealRegressions(perScenario, 'reticle')).toBe(2);
  });

  /**
   * The bug in one line. A tool with no cell at all scored the FULL denominator — one scenario more
   * than the tools that ran, since the skipped one has no NOT MEASURED verdict to exclude it.
   */
  it('gives a tool that never ran no denominator, rather than the whole grid', () => {
    expect(measuredRealRegressions(perScenario, 'agentbrowser')).toBe(0);
  });

  it('excludes a cell whose verdict is NOT MEASURED', () => {
    const only = { 'cross-component': perScenario['cross-component'] };
    expect(measuredRealRegressions(only, 'reticle')).toBe(0);
  });

  it('survives a scenario with no by_tool block', () => {
    expect(measuredRealRegressions({ x: { expected_detect: true } }, 'reticle')).toBe(0);
  });
});
