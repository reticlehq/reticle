import { ElementState, parseInteractive } from '@reticlehq/core';
import { describe, expect, it } from 'vitest';

import { RefTable, writeLines, writeWindows } from './lines.js';
import { UiRole } from './ui-node.js';
import type { UiNode } from './ui-node.js';

function node(role: UiRole, name: string, more: Partial<UiNode> = {}): UiNode {
  return { role, name, states: [], children: [], ...more };
}

const WINDOW = node(UiRole.WINDOW, 'Notes', {
  children: [
    node(UiRole.BUTTON, 'Save', { states: [ElementState.DISABLED] }),
    node(UiRole.TEXTBOX, 'Title', { value: 'He said "hi"' }),
    node(UiRole.GROUP, ''),
  ],
});

describe('writeLines', () => {
  it('writes the line format that the tree parser in core reads', () => {
    const tree = writeLines(WINDOW, new RefTable());
    expect(tree.split('\n')).toEqual([
      '- window "Notes" (ref=e1)',
      '  - button "Save" (ref=e2) [disabled]',
      '  - textbox "Title" (ref=e3) [value="He said \\"hi\\""]',
      '  - group',
    ]);
    expect(parseInteractive(tree).map((item) => item.ref)).toEqual(['e1', 'e2', 'e3']);
  });

  it('keeps the ref of an element that is still there, and never gives it to another', () => {
    const refs = new RefTable();
    writeLines(WINDOW, refs);
    const after = node(UiRole.WINDOW, 'Notes', {
      children: [node(UiRole.BUTTON, 'Delete'), node(UiRole.BUTTON, 'Save')],
    });
    expect(writeLines(after, refs).split('\n')).toEqual([
      '- window "Notes" (ref=e1)',
      '  - button "Delete" (ref=e4)',
      '  - button "Save" (ref=e2)',
    ]);
  });

  it('tells two siblings with the same role and name apart', () => {
    const twins = node(UiRole.WINDOW, 'List', {
      children: [node(UiRole.BUTTON, 'Open'), node(UiRole.BUTTON, 'Open')],
    });
    const refs = parseInteractive(writeLines(twins, new RefTable())).map((item) => item.ref);
    expect(new Set(refs).size).toBe(3);
  });

  it('leaves out the items of a closed menu, and says how many', () => {
    const app = node(UiRole.APPLICATION, 'Notes', {
      children: [
        node(UiRole.MENU, '', {
          children: [
            node(UiRole.MENUITEM, 'File', {
              children: [node(UiRole.MENU, '', { children: [node(UiRole.MENUITEM, 'New Note')] })],
            }),
          ],
        }),
        node(UiRole.WINDOW, 'Notes'),
      ],
    });
    const written = writeWindows(app, new RefTable());
    expect(written.omitted).toBe(2);
    expect(written.tree.split('\n')).toEqual([
      '- application "Notes" (ref=e1)',
      '  - menu',
      '    - menuitem "File" (ref=e2)',
      '  - window "Notes" (ref=e3)',
    ]);
  });
});
