/**
 * The HUD offers no text input.
 *
 * Users could not tell when to type into the HUD and when to type at their agent, because both were
 * a box on the same screen and nothing said which was which. There is no wording that fixes two
 * inputs that look alike and do different things; the answer is to have one.
 *
 * Scoped to the COMPOSER, not the panel. The chat panel also carries the banner, the replayable-flow
 * chips, the pause badge and the export/copy controls — all of which are read, not typed into, and
 * all of which stay.
 *
 * Removing it also takes hit-test surface out of the page. `.reticle-msg` and `.reticle-send` both
 * carried `pointer-events:auto`, and Reticle's overlay sitting in an app's hit-test path is a
 * reported defect in its own right.
 */

import { describe, expect, it } from 'vitest';
import { CONTROLS_FOOT_HTML, CONTROLS_CSS } from './presenter-controls.js';

describe('the HUD has no text input', () => {
  it('renders no textarea', () => {
    expect(CONTROLS_FOOT_HTML).not.toContain('<textarea');
  });

  it('renders no send button', () => {
    expect(CONTROLS_FOOT_HTML).not.toContain('data-reticle-send');
  });

  it('carries no composer styles, so nothing is merely hidden', () => {
    // Hiding it would leave the element in the hit-test path, which is half the reason it is going.
    expect(CONTROLS_CSS).not.toContain('.reticle-msg');
    expect(CONTROLS_CSS).not.toContain('.reticle-send');
    expect(CONTROLS_CSS).not.toContain('.reticle-composer');
  });

  it('keeps the workspace row, which shared the composer’s stack', () => {
    // The one thing that lived beside the input and is not an input.
    expect(CONTROLS_FOOT_HTML).toContain('data-reticle-foot');
    expect(CONTROLS_FOOT_HTML.length, 'the footer still renders something').toBeGreaterThan(30);
  });
});
