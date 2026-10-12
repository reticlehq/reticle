/**
 * The Harness gate scored bench-app at 75% ("missing file:line source mapping, stable test ids")
 * while its page carried 55 test ids and a `data-reticle-source` on every element: the daemon only
 * learned either from a control an agent acted on, so a tab nobody had acted on — a stray hidden one
 * `reticle connect` opened — spoke for the app. The page now says what it carries, never counting
 * Reticle's own HUD.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CoverageMarker } from '@reticlehq/core';
import { coverageMarkers } from './coverage-markers.js';
import { setPresenterVisible } from '../dom-ignore.js';

afterEach(() => {
  document.body.innerHTML = '';
  setPresenterVisible(false);
});

describe('the coverage markers a page carries', () => {
  it('names both when the app renders a test id and a source stamp', () => {
    document.body.innerHTML =
      '<button data-testid="save" data-reticle-source="src/App.tsx:12:3">Save</button>';
    expect(coverageMarkers(document)).toEqual([CoverageMarker.SOURCE, CoverageMarker.TESTID]);
  });

  it('names nothing on a page with neither', () => {
    document.body.innerHTML = '<button>Save</button>';
    expect(coverageMarkers(document)).toEqual([]);
  });

  it("never counts Reticle's own HUD, even with the hatch open", () => {
    setPresenterVisible(true);
    document.body.innerHTML =
      '<div data-reticle-hud><button data-testid="hud-run" data-reticle-source="hud.ts:1:1">Run</button></div>';
    expect(coverageMarkers(document)).toEqual([]);
  });
});
