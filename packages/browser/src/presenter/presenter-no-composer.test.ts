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
import { HUD_DRAG_IGNORE_SEL } from './presenter-config.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read as SOURCE, because the thing being asserted is an absence and there is no behaviour to
 * observe: `openChat` focusing a `querySelector` that returns null is a silent no-op, which is
 * precisely how the dead line survived a green unit run in the first place. A source read is the
 * only place that absence is visible.
 *
 * Deliberately not matched against a comment: the removal leaves no mention of the old attribute
 * anywhere in the file, so this cannot go green on prose quoting the code it replaced.
 */
const PRESENTER_SHELL_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'presenter-shell.ts'),
  'utf8',
);

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

/**
 * The leftovers, which the unit gate could not see and the e2e battery could.
 *
 * Deleting the composer's markup is not the same as deleting the composer. Two references outlived
 * it: the drag-ignore selector still listed `[data-reticle-send]`, and `openChat` still tried to
 * focus `[data-reticle-input]`. Neither throws — a selector that matches nothing is silent, and
 * `querySelector` returning null is handled — which is exactly why they survived a green unit run.
 *
 * They are not cosmetic. `HUD_DRAG_IGNORE_SEL` is the list of nodes that must not start a HUD drag,
 * and a stale entry is one more selector matched against every pointer event on the handle. The
 * plan for this removal said it in advance: removing the panel and leaving the wiring behind keeps
 * the bug and loses the feature.
 */
describe('nothing still reaches for the composer', () => {
  it('the drag-ignore selector does not name a control that no longer exists', () => {
    expect(HUD_DRAG_IGNORE_SEL).not.toContain('data-reticle-send');
    expect(HUD_DRAG_IGNORE_SEL).not.toContain('data-reticle-input');
    // The controls that DO remain are still listed — this must not pass by emptying the selector.
    expect(HUD_DRAG_IGNORE_SEL).toContain('data-reticle-pause');
    expect(HUD_DRAG_IGNORE_SEL).toContain('data-reticle-export');
  });

  it('opening the chat does not try to focus a deleted input', () => {
    expect(PRESENTER_SHELL_SRC).not.toContain('data-reticle-input');
  });
});
