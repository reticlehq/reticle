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

  /**
   * An element with a frame of no size is not on the screen: the items of a closed menu. When
   * text was selected in a field, the operating system filled a menu that was closed, and the
   * realm reported each item as an effect. A person saw none of them.
   */
  describe('an element that is not on the screen', () => {
    const menu = (open: boolean, items: readonly string[]): UiNode =>
      node(UiRole.WINDOW, 'Notes', {
        children: [
          node(UiRole.MENU, 'Services', {
            frame: open ? [0, 0, 100, 60] : [0, 0, 0, 0],
            children: items.map((name) =>
              node(UiRole.MENUITEM, name, { frame: open ? [0, 0, 100, 20] : [0, 0, 0, 0] }),
            ),
          }),
        ],
      });

    it('is not an effect when it changes', () => {
      expect(effectOf(menu(false, []), menu(false, ['Look Up'])).kind).toBe(EffectKind.NONE);
    });

    it('is an effect when it comes on the screen, and when it goes', () => {
      const opened = effectOf(menu(false, ['Look Up']), menu(true, ['Look Up']));
      expect(opened.changes.map(changeLine)).toEqual(['+ menu "Services"']);
      const closed = effectOf(menu(true, ['Look Up']), menu(false, ['Look Up']));
      expect(closed.changes.map(changeLine)).toEqual(['- menu "Services"']);
    });
  });

  /**
   * An application changes with no action: a clock, a tip that rotates, a count that updates. On
   * the first real application the realm was tried on, a press reported the tips of a panel as
   * what the press did. The realm learns the places that change by themselves, from two reads
   * with no action between them, and says so for a change in such a place.
   */
  describe('a place that changes by itself', () => {
    const app = (tip: string, status: string): UiNode =>
      node(UiRole.WINDOW, 'Todos', {
        children: [
          node(UiRole.GROUP, 'Tips', { children: [node(UiRole.TEXT, tip)] }),
          node(UiRole.GROUP, 'List', { children: [node(UiRole.TEXT, status)] }),
        ],
      });
    const restless = new Set(
      effectOf(app('Tip one', '2 todos'), app('Tip two', '2 todos')).changes.map((c) => c.within),
    );

    it('is learned from two reads with no action between them', () => {
      expect(restless.size).toBe(1);
    });

    it('is marked in the effect of an action, and the real effect is still an effect', () => {
      const effect = effectOf(app('Tip two', '2 todos'), app('Tip three', '3 todos'), restless);
      expect(effect.kind).toBe(EffectKind.CHANGED);
      expect(effect.changes.filter((c) => true === c.ambient).map((c) => c.name)).toEqual([
        'Tip two',
        'Tip three',
      ]);
      expect(effect.changes.filter((c) => true !== c.ambient).map((c) => c.name)).toEqual([
        '2 todos',
        '3 todos',
      ]);
    });

    it('is not called an effect, and not called no effect, when it is all that changed', () => {
      const effect = effectOf(app('Tip two', '2 todos'), app('Tip three', '2 todos'), restless);
      expect(effect.kind).toBe(EffectKind.AMBIENT_ONLY);
    });

    it('changes nothing for a caller that learned no place', () => {
      const effect = effectOf(app('Tip two', '2 todos'), app('Tip three', '2 todos'));
      expect(effect.kind).toBe(EffectKind.CHANGED);
      expect(effect.changes.every((c) => c.ambient === undefined)).toBe(true);
    });
  });
});
