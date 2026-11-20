/**
 * What an action changed: the difference between the tree before it and the tree after it.
 *
 * "Nothing changed" is a result here, not an absence of one. An agent that acts and gets no word
 * back cannot tell a click that did nothing from a click that worked.
 */
import { label, place, quoted } from './ui-node.js';
import type { Placed, UiNode } from './ui-node.js';

export const EffectKind = {
  /** No element appeared, went away or changed. */
  NONE: 'none',
  CHANGED: 'changed',
} as const;
export type EffectKind = (typeof EffectKind)[keyof typeof EffectKind];

export const ChangeKind = { GONE: 'gone', DIFFERENT: 'changed', NEW: 'appeared' } as const;
export type ChangeKind = (typeof ChangeKind)[keyof typeof ChangeKind];

export interface Change {
  kind: ChangeKind;
  /** `button "Save"`: the role and the name of the element. */
  element: string;
  /** For a changed element: what was different. */
  detail?: string;
  role: string;
  name: string;
  /** For a changed element: the value before and after, when it changed. */
  value?: readonly [string, string];
  /** For a changed element: the states before and after, when they changed. */
  states?: readonly [string, string];
}

export interface Effect {
  kind: EffectKind;
  /** What appeared, went away or changed. A move of the keyboard alone is not here. */
  changes: Change[];
  /**
   * The element that has the keyboard after the action, when the keyboard moved. A press on a
   * control in a web view moves the keyboard to it and can do nothing more. That is not an effect
   * of the action, or every press in a web view has one, and an action that does nothing is never
   * reported.
   */
  focusMovedTo?: string;
}

const MARK: Readonly<Record<ChangeKind, string>> = {
  [ChangeKind.GONE]: '-',
  [ChangeKind.DIFFERENT]: '~',
  [ChangeKind.NEW]: '+',
};

/** One line for a change: `-` went away, `~` changed, `+` appeared. */
export function changeLine(change: Change): string {
  const detail = change.detail === undefined ? '' : `: ${change.detail}`;
  return `${MARK[change.kind]} ${change.element}${detail}`;
}

function difference(before: UiNode, after: UiNode): Pick<Change, 'detail' | 'value' | 'states'> {
  const parts: string[] = [];
  const out: { value?: readonly [string, string]; states?: readonly [string, string] } = {};
  if ((before.value ?? '') !== (after.value ?? '')) {
    out.value = [before.value ?? '', after.value ?? ''];
    parts.push(`value ${quoted(out.value[0])} -> ${quoted(out.value[1])}`);
  }
  const was = before.states.join(',');
  const is = after.states.join(',');
  if (was !== is) {
    out.states = [was, is];
    parts.push(`states [${was}] -> [${is}]`);
  }
  return parts.length > 0 ? { ...out, detail: parts.join('; ') } : {};
}

function who(node: UiNode): Pick<Change, 'element' | 'role' | 'name'> {
  return { element: label(node), role: node.role, name: node.name };
}

function byKey(placed: readonly Placed[]): Map<string, Placed> {
  return new Map(placed.map((p) => [p.key, p]));
}

/** True when the element's parent is on the other side, so the element is the top of what moved. */
function isTopOf(p: Placed, other: ReadonlyMap<string, Placed>): boolean {
  return p.parentKey === undefined || other.has(p.parentKey);
}

export function effectOf(before: UiNode, after: UiNode): Effect {
  const was = place(before);
  const is = place(after);
  const wasByKey = byKey(was);
  const isByKey = byKey(is);
  const changes: Change[] = [];
  for (const p of was) {
    const now = isByKey.get(p.key);
    if (now === undefined) {
      if (isTopOf(p, isByKey)) {
        changes.push({ kind: ChangeKind.GONE, ...who(p.node) });
      }
    } else {
      const diff = difference(p.node, now.node);
      if (diff.detail !== undefined) {
        changes.push({ kind: ChangeKind.DIFFERENT, ...who(p.node), ...diff });
      }
    }
  }
  for (const p of is) {
    if (!wasByKey.has(p.key) && isTopOf(p, wasByKey)) {
      changes.push({ kind: ChangeKind.NEW, ...who(p.node) });
    }
  }
  const real = changes.filter((change) => !isFocusOnly(change));
  const taker = changes.find((change) => isFocusOnly(change) && tookFocus(change));
  return {
    kind: real.length > 0 ? EffectKind.CHANGED : EffectKind.NONE,
    changes: real,
    ...(taker === undefined ? {} : { focusMovedTo: taker.element }),
  };
}

const FOCUSED = 'focused';
const without = (states: string): string =>
  states
    .split(',')
    .filter((state) => state !== FOCUSED && state.length > 0)
    .join(',');

/** A change that is the keyboard coming or going, and nothing else. */
function isFocusOnly(change: Change): boolean {
  return (
    change.kind === ChangeKind.DIFFERENT &&
    change.value === undefined &&
    change.states !== undefined &&
    without(change.states[0]) === without(change.states[1])
  );
}

function tookFocus(change: Change): boolean {
  return change.states?.[1].split(',').includes(FOCUSED) ?? false;
}
