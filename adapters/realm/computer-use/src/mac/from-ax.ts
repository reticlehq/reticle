/**
 * Turns the tree that `reticle-ax` reads from the macOS Accessibility API into `UiNode`.
 *
 * It keeps every element, in order. The helper finds an element by its child index at each level,
 * so an element dropped here would move every index after it.
 */
import { ElementState } from '@reticlehq/core';
import { z } from 'zod';

import { UiRole } from '../ui-node.js';
import type { UiNode } from '../ui-node.js';

export interface AxNode {
  role: string;
  subrole?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  value?: string | undefined;
  enabled?: boolean | undefined;
  focused?: boolean | undefined;
  selected?: boolean | undefined;
  id?: string | undefined;
  help?: string | undefined;
  frame?: number[] | undefined;
  /** The place among all the children of the parent, when the helper left some out. */
  i?: number | undefined;
  /** Children the helper left out. */
  notShown?: number | undefined;
  children: AxNode[];
}

export const AxNodeSchema: z.ZodType<AxNode> = z.lazy(() =>
  z.object({
    role: z.string(),
    subrole: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    value: z.string().optional(),
    enabled: z.boolean().optional(),
    focused: z.boolean().optional(),
    selected: z.boolean().optional(),
    id: z.string().optional(),
    help: z.string().optional(),
    frame: z.array(z.number()).optional(),
    i: z.number().optional(),
    notShown: z.number().optional(),
    children: z.array(AxNodeSchema),
  }),
);

const AxRole = { STATIC_TEXT: 'AXStaticText', CHECKBOX: 'AXCheckBox' } as const;
const AX_ON = '1';
const SELECTED = 'selected';

const ROLE_OF: Readonly<Record<string, UiRole>> = {
  AXApplication: UiRole.APPLICATION,
  AXWindow: UiRole.WINDOW,
  AXSheet: UiRole.DIALOG,
  AXDialog: UiRole.DIALOG,
  AXButton: UiRole.BUTTON,
  [AxRole.CHECKBOX]: UiRole.CHECKBOX,
  AXRadioButton: UiRole.RADIO,
  AXTextField: UiRole.TEXTBOX,
  AXTextArea: UiRole.TEXTBOX,
  AXSearchField: UiRole.TEXTBOX,
  AXComboBox: UiRole.COMBOBOX,
  AXPopUpButton: UiRole.COMBOBOX,
  AXSlider: UiRole.SLIDER,
  AXScrollBar: UiRole.SCROLLBAR,
  AXLink: UiRole.LINK,
  AXMenu: UiRole.MENU,
  AXMenuBar: UiRole.MENU,
  AXMenuItem: UiRole.MENUITEM,
  AXMenuBarItem: UiRole.MENUITEM,
  AXMenuButton: UiRole.MENUITEM,
  AXRow: UiRole.ROW,
  AXCell: UiRole.CELL,
  AXList: UiRole.LIST,
  AXTable: UiRole.LIST,
  AXOutline: UiRole.LIST,
  AXImage: UiRole.IMAGE,
  [AxRole.STATIC_TEXT]: UiRole.TEXT,
  AXHeading: UiRole.HEADING,
  // The bullet or the number before a list item in a web view.
  AXListMarker: UiRole.GROUP,
  AXWebArea: UiRole.DOCUMENT,
  AXGroup: UiRole.GROUP,
  AXScrollArea: UiRole.GROUP,
  AXSplitGroup: UiRole.GROUP,
  AXTabGroup: UiRole.GROUP,
  AXRadioGroup: UiRole.GROUP,
  AXValueIndicator: UiRole.GROUP,
  AXToolbar: UiRole.GROUP,
  AXUnknown: UiRole.GROUP,
};

export interface FromAx {
  root: UiNode;
  /** The macOS roles this reader does not know. Each such element is kept, as a `group`. */
  unmapped: string[];
}

function statesOf(ax: AxNode): ElementState[] {
  const states: ElementState[] = [];
  if (false === ax.enabled) {
    states.push(ElementState.DISABLED);
  }
  if (ax.role === AxRole.CHECKBOX && ax.value === AX_ON) {
    states.push(ElementState.CHECKED);
  }
  if (true === ax.focused) {
    states.push(ElementState.FOCUSED);
  }
  return states;
}

/** The start of an identifier that AppKit makes by itself. It changes when the window is built again. */
const MADE_BY_APPKIT = '_NS:';
/**
 * An identifier that a web framework makes by itself. It is another one after the next change to
 * the page, so a saved flow that finds an element by it does not find the element again.
 * ponytail: a list of the makers that are known. An identifier of another maker is kept, and a
 * flow that is saved by it then goes "not found", which is a failure a person can see.
 */
const MADE_BY_A_FRAMEWORK = new RegExp(
  [
    // React: a colon, the letter r and a count, in small letters in the browser and in capital
    // letters from the server. React 19 puts the same between « and ».
    ':r[0-9a-z]+:',
    '«r[0-9a-z]+»',
    // A count that a library puts after its own name: Angular Material and its CDK, Ember,
    // Headless UI, React Aria.
    '^(mat|cdk|headlessui|react-aria)-.*\\d+$',
    '^ember\\d+$',
  ].join('|'),
  'i',
);

/** The identifier, when a person gave it. One that a toolkit made is not a name for anything. */
function givenId(id: string | undefined): string | undefined {
  if (id === undefined || 0 === id.length) {
    return undefined;
  }
  return id.startsWith(MADE_BY_APPKIT) || MADE_BY_A_FRAMEWORK.test(id) ? undefined : id;
}

export function fromAx(ax: AxNode): FromAx {
  const unmapped = new Set<string>();
  const convert = (node: AxNode): UiNode => {
    const role = ROLE_OF[node.role];
    if (role === undefined && node.role.length > 0) {
      unmapped.add(node.role);
    }
    // A static text has no title: its words are its value, and they are what a person reads.
    const isText = node.role === AxRole.STATIC_TEXT;
    const name = (isText ? node.value : undefined) ?? node.title ?? node.description ?? '';
    // ponytail: the wire has no "selected" state, so a chosen row says it in its value. Add the
    // state to `ElementState` in core when a second realm needs it.
    const chosen = true === node.selected ? SELECTED : undefined;
    const value = isText || AxRole.CHECKBOX === node.role ? undefined : (chosen ?? node.value);
    const id = givenId(node.id);
    const [x, y, w, h] = node.frame ?? [];
    const frame =
      x === undefined || y === undefined || w === undefined || h === undefined
        ? undefined
        : ([x, y, w, h] as const);
    return {
      role: role ?? UiRole.GROUP,
      name,
      ...(value === undefined ? {} : { value }),
      states: statesOf(node),
      ...(frame === undefined ? {} : { frame }),
      ...(node.i === undefined ? {} : { index: node.i }),
      ...(id === undefined ? {} : { id }),
      ...(node.help === undefined ? {} : { help: node.help }),
      ...(node.notShown === undefined || 0 === node.notShown ? {} : { notShown: node.notShown }),
      children: node.children.map(convert),
    };
  };
  const root = convert(ax);
  return { root, unmapped: [...unmapped].sort() };
}
