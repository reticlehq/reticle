/**
 * The HUD's one text box says who it talks to.
 *
 * The old composer went because users could not tell when to type into the HUD and when to type at
 * their agent: two boxes that looked alike and did different things, and nothing said which was
 * which. The note box that replaced it is labelled with the agent's own name and sits beside
 * "Connected: <agent>", so the question cannot arise. These pin the parts of the old removal that
 * still matter: no textarea, none of the composer's markup or styles left in the hit-test path.
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

describe('the HUD has one text box, and it names the agent it talks to', () => {
  it('renders no textarea and none of the old composer', () => {
    expect(CONTROLS_FOOT_HTML).not.toContain('<textarea');
    expect(CONTROLS_FOOT_HTML).not.toContain('data-reticle-send');
    expect(CONTROLS_CSS).not.toContain('.reticle-msg');
    expect(CONTROLS_CSS).not.toContain('.reticle-composer');
  });

  it('labels its only text box as a note to the coding agent', () => {
    document.body.innerHTML = CONTROLS_FOOT_HTML;
    const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="text"]')];
    expect(inputs.map((input) => input.getAttribute('data-reticle-agent-note'))).toEqual(['']);
    const label = document.querySelector(`label[for="${inputs[0]?.id ?? ''}"]`);
    expect(label?.hasAttribute('data-reticle-agent-label')).toBe(true);
    document.body.innerHTML = '';
  });

  it('keeps the workspace row, which shared the composer’s stack', () => {
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
    // The toolbar itself is a drag handle. Its newer view buttons must bypass the drag recognizer,
    // or pointerdown is prevented before Flows, Notes and Impact can receive their clicks.
    expect(HUD_DRAG_IGNORE_SEL).toContain('.reticle-toolbar-chrome button');
  });

  it('opening the chat does not try to focus a deleted input', () => {
    expect(PRESENTER_SHELL_SRC).not.toContain('data-reticle-input');
  });
});

/**
 * The panel's accessible name outlived the thing it named.
 *
 * `aria-label="Reticle agent chat"` was accurate when the panel hosted a composer. With the composer
 * gone the panel holds the banner, the log well, the verdict tally, the replayable-flow chips and
 * the export/copy controls — all read, none typed into — so the label promises an interaction that
 * no longer exists. A screen-reader user is told they have reached a chat and then finds nothing to
 * type into, which is a worse failure than a vague name.
 *
 * Safe to rename: `collectDialogs` excludes the HUD from `visibleDialogs` via `isReticleOverlay`,
 * structurally, not by matching this string — so the label is free to change without the HUD
 * reappearing in the app's dialog list.
 */
describe('the chat panel is not named after a control it no longer has', () => {
  it('does not call itself a chat', () => {
    expect(PRESENTER_SHELL_SRC).not.toContain('Reticle agent chat');
  });

  it('still carries an accessible name', () => {
    // The attribute is interpolated in the template (`${CHAT_PANEL_ATTR}`), so match that, not the
    // rendered attribute name — a regex over the literal silently matches nothing and passes.
    const label = /\$\{CHAT_PANEL_ATTR\}[^>]*aria-label="([^"]+)"/.exec(PRESENTER_SHELL_SRC)?.[1];
    expect(label).toBeDefined();
    expect((label ?? '').length).toBeGreaterThan(0);
  });
});
