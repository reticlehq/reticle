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

  // The three buttons at the top of a window have no title. An agent saw three buttons with no
  // name, and a press on one to find out what it does closes the window.
  it('names the buttons of a window from what the system says they are', () => {
    const window = AxNodeSchema.parse({
      role: 'AXWindow',
      title: 'Clock',
      children: [
        { role: 'AXButton', subrole: 'AXCloseButton', children: [] },
        { role: 'AXButton', subrole: 'AXMinimizeButton', children: [] },
        { role: 'AXButton', subrole: 'AXZoomButton', children: [] },
        { role: 'AXButton', subrole: 'AXCloseButton', title: 'Done', children: [] },
      ],
    });
    expect(fromAx(window).root.children.map((c) => c.name)).toEqual([
      'Close window',
      'Minimize window',
      'Zoom window',
      'Done',
    ]);
  });

  // A row of an outline has no title: its words are in a field inside it. An agent could not
  // ask for "the row Memory", and it saw thirty rows with no name.
  it('names a row with no title from the first words inside it', () => {
    const outline = AxNodeSchema.parse({
      role: 'AXOutline',
      children: [
        {
          role: 'AXRow',
          children: [
            {
              role: 'AXGroup',
              children: [{ role: 'AXDisclosureTriangle', value: '1', children: [] }],
            },
            { role: 'AXTextField', value: 'Hardware', children: [] },
          ],
        },
        { role: 'AXRow', children: [{ role: 'AXStaticText', value: 'Memory', children: [] }] },
        {
          role: 'AXRow',
          title: 'Named',
          children: [{ role: 'AXStaticText', value: 'x', children: [] }],
        },
        { role: 'AXRow', children: [] },
      ],
    });
    expect(fromAx(outline).root.children.map((c) => c.name)).toEqual([
      'Hardware',
      'Memory',
      'Named',
      '',
    ]);
  });

  // The small arrow that opens a row of an outline. It was a group with the value 1, so an agent
  // could not know that the row opens, or that it is open.
  it('reads the arrow that opens a row as a button, and says when the row is open', () => {
    const row = AxNodeSchema.parse({
      role: 'AXRow',
      children: [
        { role: 'AXDisclosureTriangle', value: '1', children: [] },
        { role: 'AXDisclosureTriangle', value: '0', children: [] },
        { role: 'AXSplitter', children: [] },
      ],
    });
    const { root, unmapped } = fromAx(row);
    expect(unmapped).toEqual([]);
    expect(root.children.map((c) => [c.role, c.name, c.value, c.states])).toEqual([
      ['button', 'Show or hide rows', undefined, [ElementState.EXPANDED]],
      ['button', 'Show or hide rows', undefined, []],
      ['group', '', undefined, []],
    ]);
  });

  // Granola gives the menu of a meeting with no name, no text and no tip. A person tells such a
  // control apart by what is beside it. An agent saw thirty-six menus with no name.
  it('names a control that has no name by the nearest named thing beside it', () => {
    const list = AxNodeSchema.parse({
      role: 'AXList',
      title: 'Meetings',
      children: [
        {
          role: 'AXGroup',
          children: [
            { role: 'AXCheckBox', title: 'Select Weekly sync', children: [] },
            { role: 'AXButton', title: 'Weekly sync', children: [] },
            {
              role: 'AXGroup',
              children: [
                { role: 'AXGroup', children: [] },
                { role: 'AXPopUpButton', children: [] },
              ],
            },
          ],
        },
        { role: 'AXPopUpButton', children: [] },
      ],
    });
    const row = fromAx(list).root.children[0];
    expect(row?.children[2]?.children[1]?.name).toBe('Menu by Weekly sync');
    // Beside the row: the named thing nearest to it in the order of the tree is the meeting.
    expect(fromAx(list).root.children[1]?.name).toBe('Menu by Weekly sync');
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

  // A saved flow finds an element by the identifier its maker gave it. An identifier that AppKit
  // made by itself ("_NS:8") is another one the next time the window is built.
  it('keeps the identifier a person gave, and not one the toolkit made', () => {
    const { root } = fromAx({
      role: 'AXWindow',
      children: [
        { role: 'AXButton', title: 'Delete', id: 'delete-beta', children: [] },
        { role: 'AXButton', title: 'Delete', id: '_NS:8', children: [] },
        { role: 'AXButton', title: 'Delete', children: [] },
      ],
    });
    expect(root.children.map((child) => child.id)).toEqual(['delete-beta', undefined, undefined]);

    const web = fromAx({
      role: 'AXWebArea',
      children: [
        ':r1:',
        ':R5d:',
        'radix-:r3:',
        '«r2»',
        'mat-input-0',
        'cdk-overlay-12',
        'ember123',
        'headlessui-menu-button-4',
        'add',
        'row:3',
        'material-list',
        'embers',
      ].map((id) => ({
        role: 'AXButton',
        title: 'Open',
        id,
        children: [],
      })),
    });
    expect(web.root.children.map((child) => child.id)).toEqual([
      ...Array.from({ length: 8 }, () => undefined),
      'add',
      'row:3',
      'material-list',
      'embers',
    ]);
  });
});
