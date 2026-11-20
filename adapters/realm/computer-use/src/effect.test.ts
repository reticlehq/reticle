import { ElementState } from '@reticlehq/core';
import { describe, expect, it } from 'vitest';

import { EffectKind, changeLine, effectOf } from './effect.js';
import { UiRole } from './ui-node.js';
import type { UiNode } from './ui-node.js';

function node(role: UiRole, name: string, more: Partial<UiNode> = {}): UiNode {
  return { role, name, states: [], children: [], ...more };
}

const before = node(UiRole.WINDOW, 'Notes', {
  children: [node(UiRole.BUTTON, 'Save'), node(UiRole.TEXTBOX, 'Title', { value: '' })],
});

describe('effectOf', () => {
  it('says so when an action changed nothing', () => {
    const effect = effectOf(before, structuredClone(before));
    expect(effect.kind).toBe(EffectKind.NONE);
    expect(effect.changes).toEqual([]);
  });

  it('names what appeared, what went away and what changed', () => {
    const after = node(UiRole.WINDOW, 'Notes', {
      children: [
        node(UiRole.TEXTBOX, 'Title', { value: 'Plan', states: [ElementState.FOCUSED] }),
        node(UiRole.DIALOG, 'Saved'),
      ],
    });
    const effect = effectOf(before, after);
    expect(effect.kind).toBe(EffectKind.CHANGED);
    expect(effect.changes.map(changeLine)).toEqual([
      '- button "Save"',
      '~ textbox "Title": value "" -> "Plan"; states [] -> [focused]',
      '+ dialog "Saved"',
    ]);
  });

  it('does not call a move of the keyboard an effect, and says where the keyboard went', () => {
    const page = (focused: string, status: string): UiNode =>
      node(UiRole.WINDOW, 'Orders', {
        children: [
          node(UiRole.BUTTON, 'Save', { states: 'Save' === focused ? [ElementState.FOCUSED] : [] }),
          node(UiRole.BUTTON, 'Dead', { states: 'Dead' === focused ? [ElementState.FOCUSED] : [] }),
          node(UiRole.TEXT, status),
        ],
      });
    // A press on a button in a web view that does nothing: the keyboard moves to it, and that is all.
    const nothing = effectOf(page('Save', 'Ready'), page('Dead', 'Ready'));
    expect(nothing.kind).toBe(EffectKind.NONE);
    expect(nothing.changes).toEqual([]);
    expect(nothing.focusMovedTo).toBe('button "Dead"');

    // The same press with a real effect keeps the effect, and still says where the keyboard went.
    const saved = effectOf(page('Dead', 'Ready'), page('Save', 'Saved'));
    expect(saved.kind).toBe(EffectKind.CHANGED);
    expect(saved.changes.map(changeLine)).toEqual(['- text "Ready"', '+ text "Saved"']);
    expect(saved.focusMovedTo).toBe('button "Save"');
  });
});
