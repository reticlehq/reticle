/**
 * What the peer knows about the actions of a form: which action of a tool is which kind of
 * action of the realm, what a field holds after an action, and the identifier of an element.
 */
import { ActionType, ElementState } from '@reticlehq/core';

import { ActKind } from '../driver.js';
import type { ActOutcome } from '../driver.js';
import { UiRole, place } from '../ui-node.js';
import type { Placed, UiNode } from '../ui-node.js';
import { see } from './seen.js';
import type { Seen } from './seen.js';

/** The keys that select all the text of a field, and that remove what is selected. */
export const SELECT_ALL = 'Meta+a';
export const DELETE = 'Backspace';
export const ESCAPE = 'Escape';
/** The choices a refusal names. A long menu is not put in an error. */
export const CHOICES_NAMED = 20;
/** The roles whose value is the text a fill asks for. A slider's value is a number in another form. */
export const TEXT_ROLES: ReadonlySet<string> = new Set([UiRole.TEXTBOX, UiRole.COMBOBOX]);

/** The value an element holds after an action. */
export function heldBy(outcome: ActOutcome, key: string): string {
  return place(outcome.after.root).find((p) => p.key === key)?.node.value ?? '';
}

/**
 * Where a field is after it took a value, when it is not at its key any more: an application can
 * put the field in another group as it shows results. The answer is the one element with the
 * same role, name and identifier that holds exactly the value that was set. With two such
 * elements, or none, there is no answer: a guess would give the ref to another element.
 */
export function movedTo(outcome: ActOutcome, target: Placed, value: string): Placed | undefined {
  const after = place(outcome.after.root);
  if (after.some((p) => p.key === target.key)) {
    return undefined;
  }
  const same = after.filter(
    (p) =>
      p.node.role === target.node.role &&
      p.node.name === target.node.name &&
      p.node.id === target.node.id &&
      p.node.value === value,
  );
  return 1 === same.length ? same[0] : undefined;
}

export const KIND_OF: Readonly<Partial<Record<string, ActKind>>> = {
  [ActionType.CLICK]: ActKind.PRESS,
  [ActionType.FILL]: ActKind.SET,
  [ActionType.TYPE]: ActKind.TYPE,
  [ActionType.PRESS]: ActKind.KEY,
  [ActionType.CLEAR]: ActKind.SET,
  [ActionType.CHECK]: ActKind.PRESS,
  [ActionType.UNCHECK]: ActKind.PRESS,
  [ActionType.SUBMIT]: ActKind.KEY,
  [ActionType.DBLCLICK]: ActKind.DBLCLICK,
  [ActionType.HOVER]: ActKind.HOVER,
  [ActionType.DRAG]: ActKind.DRAG,
  [ActionType.FOCUS]: ActKind.RAISE,
};
/**
 * The kinds that use the real pointer or bring the application to the front. Each takes the
 * pointer or the keyboard of the person at the machine, so a caller asks for it by name.
 */
export const FOREGROUND_ONLY: ReadonlySet<string> = new Set([
  ActKind.CLICK,
  ActKind.DBLCLICK,
  ActKind.RIGHTCLICK,
  ActKind.HOVER,
  ActKind.DRAG,
  ActKind.RAISE,
  ActKind.WHEEL,
]);
/** The actions that carry their own value: a caller gives none. */
export const VALUE_OF: Readonly<Partial<Record<string, string>>> = {
  [ActionType.CLEAR]: '',
  [ActionType.SUBMIT]: 'Return',
};
/** The state each of these actions asks for. */
export const WANTS_CHECKED: Readonly<Partial<Record<string, boolean>>> = {
  [ActionType.CHECK]: true,
  [ActionType.UNCHECK]: false,
};
export const BOX_ROLES: ReadonlySet<string> = new Set([UiRole.CHECKBOX, UiRole.RADIO]);
export const isChecked = (node: UiNode): boolean => node.states.includes(ElementState.CHECKED);
/** The actions this realm does. The peer declares exactly these to the bridge. */
export const PEER_ACTIONS: readonly string[] = [
  ...Object.keys(KIND_OF),
  ActionType.SCROLL,
  ActionType.SELECT,
];

/**
 * The identifier of the target, as the server reads it to anchor a saved step. When several
 * elements on the screen share it, how many, and which of them the target is.
 */
export function testidOf(target: Seen, before: UiNode): Record<string, unknown> {
  const id = target.node.id;
  if (id === undefined) {
    return {};
  }
  const sharing = see(before).filter((s) => s.node.id === id);
  if (sharing.length < 2) {
    return { testid: id };
  }
  return {
    testid: id,
    testidOf: sharing.length,
    testidNth: sharing.findIndex((s) => s.key === target.key),
  };
}

export const SettleReason = { TIMEOUT: 'timeout' } as const;

/** The answer to one action, in the shape the server reads. */
export interface ActResult {
  ok: true;
  ref: string;
  action: string;
  /** False when nothing was sent: the element was in the state the caller asked for. */
  dispatched: boolean;
  settled: boolean;
  settleReason: string | null;
  effect: Record<string, unknown>;
  role: string;
  name: string;
  testid?: string;
  testidOf?: number;
  testidNth?: number;
}
