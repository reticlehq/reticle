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
});
