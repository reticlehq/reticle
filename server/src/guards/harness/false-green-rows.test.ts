/**
 * A row in the third-party false-green corpus is only a row once it has been MEASURED.
 *
 * The corpus exists because our own fixtures are too easy: they contain the defects we chose, shaped
 * by the same understanding that built the detectors. A row fixes that by taking its ground truth
 * from somebody else's history — an upstream commit that fixed a bug and shipped the regression test
 * for it — so the bug is real, it shipped, and a maintainer fixed it.
 *
 * That only holds if the pair was actually run. A candidate that LOOKS like a fix-with-test but whose
 * test does not fail at the parent is not ground truth, and putting one in would make the scorecard
 * read stronger than it is — the exact failure the corpus exists to prevent, committed into the
 * instrument that is supposed to detect it.
 *
 * So: every row carries its measurement, and every ref is immutable. A branch name here would let
 * upstream move a row under the measurement without anyone noticing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../repo-root.js';

const ROWS = join(REPO_ROOT, 'bench/false-green-corpus/rows.json');
const corpus = JSON.parse(readFileSync(ROWS, 'utf8')) as {
  rows: {
    id: string;
    fixedRef: string;
    brokenRef: string;
    oracle?: { kind?: string; command?: string };
    verified?: { fixedRef?: string; brokenRef?: string; failing?: string[] };
    whyItIsAFalseGreen?: string;
  }[];
};

/** A commit sha, not a branch: `main` can move, a sha cannot. */
const IMMUTABLE_REF = /^[0-9a-f]{7,40}(~\d+)?$/;

describe('the third-party false-green corpus', () => {
  it('has rows at all — a guard over an empty corpus proves nothing', () => {
    expect(corpus.rows.length).toBeGreaterThan(0);
  });

  it.each(corpus.rows.map((r) => [r.id, r] as const))(
    '%s pins immutable refs, so upstream cannot move it under the measurement',
    (_id, row) => {
      expect(row.fixedRef).toMatch(IMMUTABLE_REF);
      expect(row.brokenRef).toMatch(IMMUTABLE_REF);
      expect(row.brokenRef, 'broken and fixed must differ, or the row measures nothing').not.toBe(
        row.fixedRef,
      );
    },
  );

  it.each(corpus.rows.map((r) => [r.id, r] as const))(
    '%s carries the measurement that makes it a row rather than a candidate',
    (_id, row) => {
      expect(
        row.verified,
        'a candidate becomes a row only after the oracle is run at BOTH refs. Without that, this ' +
          "is somebody's guess about a commit, and a guess in a false-green corpus makes the " +
          'scorecard read stronger than it is.',
      ).toBeDefined();
      expect(row.verified?.brokenRef, 'the broken ref must record a FAILURE').toMatch(/fail/i);
      expect(row.verified?.fixedRef, 'the fixed ref must record a PASS').toMatch(/pass/i);
      expect(
        (row.verified?.failing ?? []).length,
        'name WHICH assertions failed: "the suite went red" does not show the oracle is specific ' +
          'to this defect rather than to a broken build',
      ).toBeGreaterThan(0);
    },
  );

  it.each(corpus.rows.map((r) => [r.id, r] as const))(
    '%s says why the defect is a FALSE GREEN and not merely a bug',
    (_id, row) => {
      expect(
        (row.whyItIsAFalseGreen ?? '').length,
        'the corpus measures false greens: broken but LOOKS fine. A defect that announces itself ' +
          'belongs in a different benchmark.',
      ).toBeGreaterThan(40);
    },
  );
});

/**
 * A row must be able to prove it is driving the RIGHT application.
 *
 * The corpus measures whether Reticle catches a defect. That means nothing unless the app under the
 * cursor is the one the defect lives in, and an app can render, connect and return a green verdict
 * while being something else entirely.
 *
 * Measured on the first row: nuclear's `main.tsx` branches on `window.__TAURI_INTERNALS__`. Under
 * Tauri it loads the PLAYER, where this row's defect lives; in a plain browser it loads a REMOTE
 * CONTROL app. A bare `vite` therefore renders 1867 characters of "Connecting to Nuclear..." and
 * `reticle_assert` returns `verified: "yes"` for text on it. That verdict is real, and it is about
 * the wrong application. Scoring against it would have produced a false green inside the instrument
 * built to measure false greens.
 *
 * So every row names something that identifies its app, and says plainly whether it can be driven at
 * all. `drivableInBrowser: false` is a fine answer — it routes the row to the desktop path instead
 * of silently scoring it in the wrong place.
 */
/** A row whose app has not been booted yet says so, rather than leaving the field out. */
const UNMEASURED = 'unmeasured';

describe('a row can prove it is driving the right application', () => {
  it.each(corpus.rows.map((r) => [r.id, r] as const))(
    '%s names an identifying marker for its app',
    (_id, row) => {
      const marker = (row as { boot?: { identifies?: { textContains?: string } } }).boot?.identifies
        ?.textContains;
      expect(
        (marker ?? '').length,
        'without a marker, a row can be scored against a different app that happens to render — ' +
          'which is a false green inside the false-green corpus',
      ).toBeGreaterThan(0);
    },
  );

  it.each(corpus.rows.map((r) => [r.id, r] as const))(
    '%s states whether it is drivable in a browser at all',
    (_id, row) => {
      const drivable = (row as { boot?: { drivableInBrowser?: boolean | string } }).boot
        ?.drivableInBrowser;
      expect(
        'boolean' === typeof drivable || UNMEASURED === drivable,
        'UNSTATED is the dangerous value: it reads as "probably fine" and is how a row gets scored ' +
          'in the wrong runtime. `false` is a perfectly good answer, and so is the explicit ' +
          `"${UNMEASURED}" for a row whose app has not been booted yet — what must never appear ` +
          'is silence.',
      ).toBe(true);
    },
  );
});

/**
 * The third criterion, and the one that cost the most to learn: a row's defect must be visible
 * through a channel Reticle actually has.
 *
 * Excalidraw satisfies the other two comfortably — an auditable upstream oracle (51 pass at the fix,
 * exactly its 2 new assertions fail at the parent) and a plain web app with no native runtime. Its
 * defect is the ORDER of a container and its bound text after restore, deciding z-order and which
 * element a later edit binds to. Excalidraw draws through StaticCanvas/InteractiveCanvas. Reticle
 * observes DOM, state and network, and none of them can see inside a canvas.
 *
 * Scoring that row would have recorded a MISS, and the number would have been real and meaningless:
 * a measurement of the documented canvas blind spot rather than of whether Reticle reports honestly.
 * A corpus that quietly mixes the two produces a false-green rate nobody can act on, because the
 * fix it implies (see the canvas gap) is not the fix it appears to name.
 *
 * So `scoreable` is explicit and carries its reason. An unscoreable row still earns its place: it is
 * a verified pair, and it is the evidence for which apps belong in this corpus at all.
 */
describe('a row says whether it can be scored, and why not', () => {
  it.each(corpus.rows.map((r) => [r.id, r] as const))('%s states scoreability', (_id, row) => {
    const r = row as { scoreable?: boolean; notScoreableReason?: string };
    expect(
      typeof r.scoreable,
      'UNSTATED reads as "score it" — which is how a canvas-internal or wrong-runtime defect ' +
        'silently becomes a number about something else',
    ).toBe('boolean');
    if (false === r.scoreable) {
      expect(
        (r.notScoreableReason ?? '').length,
        'an unscoreable row without a reason is indistinguishable from an abandoned one',
      ).toBeGreaterThan(40);
    }
  });

  it('records the criteria a row must satisfy, so the next row is not chosen by taste', () => {
    const criteria = (corpus as { $selectionCriteria?: Record<string, unknown> })
      .$selectionCriteria;
    expect(Object.keys(criteria ?? {}).length).toBeGreaterThanOrEqual(4);
  });
});
