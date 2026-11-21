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
  HEADING: 'heading',
  /** The page in a web view. */
  DOCUMENT: 'document',
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
  /**
   * The identifier the maker of the application gave the element. It does not change when the
   * words on the element change, so a saved flow finds the element by it. Absent: none was given.
   */
  id?: string;
  /**
   * The words a person gets when the pointer rests on the element: its tooltip. The realm reads
   * them from the tree. It does not move a pointer.
   */
  help?: string;
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
/** A group with no name: the item of a list, when it has twins beside it. */
function isListItem(node: UiNode): boolean {
  return node.role === UiRole.GROUP && 0 === node.name.length;
}

/** The roles of the children of an element, in order. Two items of one list have the same. */
function shapeOf(node: UiNode): string {
  return node.children.map((child) => child.role).join(' ');
}

/** The first words in an element, from a text or a field below it. Only for a key. */
function firstWords(node: UiNode): string {
  for (const child of node.children) {
    const holds = child.role === UiRole.TEXT || child.role === UiRole.TEXTBOX;
    const own = holds ? child.name || (child.value ?? '') : '';
    const found = 0 === own.length ? firstWords(child) : own;
    if (found.length > 0) {
      return found;
    }
  }
  return '';
}

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
    // Groups with no name, two or more side by side, are the items of a list. Their place among
    // their twins is not who they are: a row that comes above them moves each one down, and the
    // key of the second row was then the key of the row that took its place. A ref given for the
    // Delete of "beta" pressed the Delete of "alpha". So each such item is known by its words.
    // Only twins of the same shape: a group of keys beside a toolbar is no list, and the words of
    // the display in it change with each key.
    const shapes = new Map<string, number>();
    for (const child of node.children.filter(isListItem)) {
      shapes.set(shapeOf(child), (shapes.get(shapeOf(child)) ?? 0) + 1);
    }
    node.children.forEach((child, order) => {
      const item = isListItem(child) && (shapes.get(shapeOf(child)) ?? 0) > 1;
      const words = item ? firstWords(child) : '';
      const own = 0 === words.length ? label(child) : `${label(child)} ${quoted(words)}`;
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
 *
 * An element of a page that is wholly outside its window is scrolled out, and it is not shown.
 * Safari gives the text below the window with its true place. The rule is for a page alone: a
 * menu of the application can open past the edge of its window, and a person sees it there.
 *
 * One pixel counts as no size. A Chromium browser gives the text that is scrolled out of a page
 * as a strip one pixel high at the edge of the window, and a person cannot see or click that.
 */
/** The most pixels, of a width or a height, that still count as no size. */
const THIN = 1;

export function placeShown(root: UiNode): { shown: Placed[]; omitted: number } {
  const hidden = new Set<string>();
  const shown: Placed[] = [];
  // For each element: the frame of its window, and true when it is in a page.
  const windows = new Map<string, Frame | undefined>();
  const inPage = new Set<string>();
  for (const p of place(root)) {
    const frame = p.node.frame;
    const above = p.parentKey;
    const fromAbove = above === undefined ? undefined : windows.get(above);
    windows.set(p.key, p.node.role === UiRole.WINDOW ? frame : fromAbove);
    if (p.node.role === UiRole.DOCUMENT || (above !== undefined && inPage.has(above))) {
      inPage.add(p.key);
    }
    const noSize = frame !== undefined && (frame[2] <= THIN || frame[3] <= THIN);
    const scrolledOut =
      frame !== undefined &&
      p.node.role !== UiRole.DOCUMENT &&
      inPage.has(p.key) &&
      outside(frame, windows.get(p.key));
    if (noSize || scrolledOut || (above !== undefined && hidden.has(above))) {
      hidden.add(p.key);
    } else {
      shown.push(p);
    }
  }
  return { shown, omitted: hidden.size };
}

type Frame = readonly [number, number, number, number];

/** True when no part of the frame is in the window. A window with no frame hides nothing. */
function outside(frame: Frame, window: Frame | undefined): boolean {
  if (window === undefined) {
    return false;
  }
  return (
    frame[0] >= window[0] + window[2] ||
    frame[0] + frame[2] <= window[0] ||
    frame[1] >= window[1] + window[3] ||
    frame[1] + frame[3] <= window[1]
  );
}
