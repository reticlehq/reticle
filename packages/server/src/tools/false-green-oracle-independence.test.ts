/**
 * The thing that decides whether the app is broken must not be Reticle.
 *
 * The false-green rate is the number the whole product rests on: how often an agent is told a thing
 * works when it does not. Everything else — token cost, latency, ergonomics — is downstream of it.
 *
 * Which makes the measurement's own integrity load-bearing, and gives it one failure mode that is
 * silent and total: **grading Reticle with Reticle turns a false-green measurement into a
 * self-portrait.** If ground truth is derived from the same machinery being graded, a detector and
 * its own scorecard drift together and the number keeps looking excellent while meaning nothing.
 *
 * Today that property HOLDS by construction — `bench/pw-vs-reticle/bugs.mjs` is pure declarative
 * data with no imports at all, and each bug's ground truth is a check KIND rather than a verdict. It
 * holds because somebody was careful, and nothing would notice if they stopped being careful. This
 * repo's own history is unambiguous about what that is worth: a rule everyone agrees with and
 * nothing checks is the shape of every silent failure here. Telemetry failed that way for months.
 *
 * So the rule is mechanical, in the same spirit as "`adapters/realm/dom` never imports Node APIs" and
 * "`core` may not gain dependencies": the ground-truth module imports NOTHING. Not Reticle, not a
 * helper that might one day import Reticle, not anything at all. A registry of what is broken is
 * data, and data has no dependencies.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The registry that says which bug is present, i.e. the ground truth the scorecard is scored on. */
const GROUND_TRUTH = join(import.meta.dirname, '../../../../bench/pw-vs-reticle/bugs.mjs');

/** Any static import or require, however it is spelled. */
const IMPORTS = /(?:^|\n)\s*import\s|(?:^|[^.\w])require\s*\(|\bimport\s*\(/;

/** The scorecard the false-green figure is published in. */
const SCORECARD = join(import.meta.dirname, '../../../../bench/FALSE-GREEN-SCORECARD.md');

/** The row that states the headline false-green figure for each tool. */
const FALSE_GREEN_ROW = /^\|\s*\*\*False greens\*\*[^|]*\|(.+)$/m;

describe('the false-green ground truth is independent of Reticle', () => {
  it('finds the registry at all — a guard over a missing file is not a guard', () => {
    expect(
      existsSync(GROUND_TRUTH),
      `${GROUND_TRUTH} is the ground truth the false-green scorecard is scored against. If it moved, ` +
        'move this guard with it rather than deleting it.',
    ).toBe(true);
  });

  it('imports nothing, so it cannot be graded by the machinery it grades', () => {
    const source = readFileSync(GROUND_TRUTH, 'utf8');
    expect(
      IMPORTS.test(source),
      'The registry of what is broken must be data. An import here is how ground truth starts ' +
        'agreeing with the detector it is supposed to judge, and the scorecard becomes a ' +
        'self-portrait that still reads excellent.',
    ).toBe(false);
  });

  it('names no Reticle package, even in a comment that could become code', () => {
    const source = readFileSync(GROUND_TRUTH, 'utf8');
    expect(source).not.toContain('@reticlehq/');
  });
});

/**
 * A false-green figure without its denominator is not a measurement.
 *
 * "False greens: 1" falls when usage falls, and read a year later it cannot distinguish "Reticle got
 * better" from "the corpus got smaller". The scorecard is hand-maintained, so the rule is enforced
 * on the published number rather than trusted to whoever next edits the table.
 */
describe('the published false-green figure carries its denominator', () => {
  it('finds the scorecard row — a guard over a row that moved is not a guard', () => {
    expect(existsSync(SCORECARD)).toBe(true);
    expect(FALSE_GREEN_ROW.test(readFileSync(SCORECARD, 'utf8'))).toBe(true);
  });

  it('states every figure as a fraction, never as a bare count', () => {
    const row = FALSE_GREEN_ROW.exec(readFileSync(SCORECARD, 'utf8'))?.[1] ?? '';
    const figures = row
      .split('|')
      .map((cell) => cell.replaceAll('*', '').trim())
      .filter((cell) => cell.length > 0);
    expect(figures.length, 'expected one figure per tool').toBeGreaterThan(0);
    for (const figure of figures) {
      expect(
        figure,
        `"${figure}" is a bare count. A raw false-green number falls when usage falls, so it must ` +
          'be stated per verification (e.g. "1 / 88") to mean anything later.',
      ).toMatch(/\d+\s*\/\s*\d+/);
    }
  });
});
