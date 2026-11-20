/**
 * One element of an application's user interface, as the operating system's accessibility tree
 * describes it. Every reader (macOS AX, Windows UI Automation, Linux AT-SPI) gives this one shape,
 * so nothing after the reader knows which operating system the element came from.
 */
import type { ElementState } from '@reticlehq/core';

/** Roles are lower-case letters only: the tree parsers in `core` and the Harness read `[a-z]+`. */
export const UiRole = {
  APPLICATION: 'application',
  WINDOW: 'window',
  DIALOG: 'dialog',
  BUTTON: 'button',
  CHECKBOX: 'checkbox',
  RADIO: 'radio',
  TEXTBOX: 'textbox',
  COMBOBOX: 'combobox',
  SLIDER: 'slider',
  SCROLLBAR: 'scrollbar',
  LINK: 'link',
  MENU: 'menu',
  MENUITEM: 'menuitem',
  TAB: 'tab',
  ROW: 'row',
  CELL: 'cell',
  LIST: 'list',
  IMAGE: 'img',
  TEXT: 'text',
  GROUP: 'group',
} as const;
export type UiRole = (typeof UiRole)[keyof typeof UiRole];

export interface UiNode {
  role: UiRole;
  /** The accessible name. Empty when the application gives none. */
  name: string;
  value?: string;
  states: readonly ElementState[];
  /** Where the element is on the screen: x, y, width, height. Absent when the reader has none. */
  frame?: readonly [number, number, number, number];
  /**
   * The place of the element among ALL the children of its parent, when the reader left some out.
   * Absent: the reader gave every child, and the place is the order here.
   */
  index?: number;
  /** Children the reader left out: the rows of a table that are not on the screen. */
  notShown?: number;
  children: readonly UiNode[];
}

/** A person can act on these, so each one gets a ref even when it has no name. */
const INTERACTIVE: ReadonlySet<UiRole> = new Set([
  UiRole.BUTTON,
  UiRole.CHECKBOX,
  UiRole.RADIO,
  UiRole.TEXTBOX,
  UiRole.COMBOBOX,
  UiRole.SLIDER,
  UiRole.LINK,
  UiRole.MENUITEM,
  UiRole.TAB,
  // A row has no name of its own, and a person clicks it to choose it.
  UiRole.ROW,
]);

export function isAddressable(node: UiNode): boolean {
  return INTERACTIVE.has(node.role) || node.name.length > 0;
}

/** A string in double quotes, with the escapes the tree parsers read back. */
export function quoted(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', ' ')}"`;
}

/** `button "Save"`: the role, and the name when there is one. */
export function label(node: UiNode): string {
  return node.name.length > 0 ? `${node.role} ${quoted(node.name)}` : node.role;
}

export interface Placed {
  node: UiNode;
  depth: number;
  /** Where the element is: the labels from the root down, each with its place among its twins. */
  key: string;
  parentKey: string | undefined;
  /** The child index at each level from the root. A reader finds the element again with it. */
  path: readonly number[];
}

/**
 * Every element in document order, each with a key that stays the same from one read to the next.
 *
 * The accessibility tree gives no stable id, so the key is the path. Two siblings with the same
 * role and name differ by their order.
 * ponytail: a path key changes when an ancestor is renamed. Use the operating system's own
 * identifier (`AXIdentifier`, `AutomationId`) when the reader has one.
 */
export function place(root: UiNode): Placed[] {
  const out: Placed[] = [];
  const visit = (
    node: UiNode,
    path: readonly number[],
    key: string,
    parentKey: string | undefined,
  ): void => {
    out.push({ node, depth: path.length, key, parentKey, path });
    const seen = new Map<string, number>();
    node.children.forEach((child, order) => {
      const own = label(child);
      const twin = seen.get(own) ?? 0;
      seen.set(own, twin + 1);
      // A row of a table keeps its place in the whole table. After a scroll the first row that
      // shows is another row, and it must not get the key, and so the ref, of the row before it.
      const nth = child.index === undefined ? String(twin) : `i${String(child.index)}`;
      visit(child, [...path, child.index ?? order], `${key}/${own}#${nth}`, key);
    });
  };
  visit(root, [], label(root), undefined);
  return out;
}

/**
 * The elements that have a place on the screen, and how many do not.
 *
 * An element with a frame of no size is not drawn: the items of a closed menu are the usual case,
 * and they are most of an application's elements. A person cannot see or click them, so they are
 * not shown and not offered as a target. When the menu is open its items have a size, and they
 * are here. An element with no frame at all is kept: the reader did not say where it is.
 */
export function placeShown(root: UiNode): { shown: Placed[]; omitted: number } {
  const hidden = new Set<string>();
  const shown: Placed[] = [];
  for (const p of place(root)) {
    const frame = p.node.frame;
    const noSize = frame !== undefined && (frame[2] <= 0 || frame[3] <= 0);
    if (noSize || (p.parentKey !== undefined && hidden.has(p.parentKey))) {
      hidden.add(p.key);
    } else {
      shown.push(p);
    }
  }
  return { shown, omitted: hidden.size };
}
