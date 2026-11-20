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
  id?: string | undefined;
  frame?: number[] | undefined;
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
    id: z.string().optional(),
    frame: z.array(z.number()).optional(),
    children: z.array(AxNodeSchema),
  }),
);

const AxRole = { STATIC_TEXT: 'AXStaticText', CHECKBOX: 'AXCheckBox' } as const;
const AX_ON = '1';

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
    const value = isText || node.role === AxRole.CHECKBOX ? undefined : node.value;
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
      children: node.children.map(convert),
    };
  };
  const root = convert(ax);
  return { root, unmapped: [...unmapped].sort() };
}
