import { readFileSync } from 'node:fs';

import { ElementState } from '@reticlehq/core';
import { describe, expect, it } from 'vitest';

import { RefTable, writeLines } from '../lines.js';
import { AxNodeSchema, fromAx } from './from-ax.js';

/** Read from `native/mac/fixture.swift` by `reticle-ax tree` on macOS 26. */
const recorded: unknown = JSON.parse(
  readFileSync(new URL('recorded/fixture-app.json', import.meta.url), 'utf8'),
);

describe('fromAx', () => {
  it('reads a recorded macOS tree into the lines an agent reads', () => {
    const { root, unmapped } = fromAx(AxNodeSchema.parse(recorded));
    expect(unmapped).toEqual([]);
    expect(writeLines(root, new RefTable()).split('\n')).toEqual([
      '- application "fixture" (ref=e1)',
      '  - window "Reticle Fixture" (ref=e2)',
      '    - textbox "Title" (ref=e3) [focused]',
      '    - text "Ready" (ref=e4)',
      '    - button "Save" (ref=e5)',
      '    - button "Slow" (ref=e6)',
      '    - button "Dead" (ref=e7)',
      '    - button "Covered" (ref=e8)',
      '    - text "Reticle Fixture" (ref=e9)',
    ]);
  });

  it('names each role it does not know, and keeps the element', () => {
    const { root, unmapped } = fromAx({
      role: 'AXWindow',
      title: 'W',
      children: [{ role: 'AXLevelIndicator', children: [] }],
    });
    expect(unmapped).toEqual(['AXLevelIndicator']);
    expect(root.children).toHaveLength(1);
  });

  it('reads the states an agent must know before it acts', () => {
    const { root } = fromAx({
      role: 'AXWindow',
      children: [
        { role: 'AXButton', title: 'Pay', enabled: false, children: [] },
        { role: 'AXCheckBox', title: 'Agree', value: '1', focused: true, children: [] },
      ],
    });
    expect(root.children.map((c) => c.states)).toEqual([
      [ElementState.DISABLED],
      [ElementState.CHECKED, ElementState.FOCUSED],
    ]);
  });
});
