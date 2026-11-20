/**
 * What an action changed: the difference between the tree before it and the tree after it.
 *
 * "Nothing changed" is a result here, not an absence of one. An agent that acts and gets no word
 * back cannot tell a click that did nothing from a click that worked.
 */
import { label, place, placeShown, quoted } from './ui-node.js';
import type { Placed, UiNode } from './ui-node.js';

export const EffectKind = {
  /** No element appeared, went away or changed. */
  NONE: 'none',
  CHANGED: 'changed',
  /**
   * Something changed, and only in places that change with no action. The realm cannot say that
   * the action did it, and cannot say that it did not.
   */
  AMBIENT_ONLY: 'ambient-only',
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
  /** The key of the element that holds this one. */
  within: string;
  /**
   * Where the change is: the parent, the role and the corner of the element. An element that is
   * given new words (a clock, a count) has a new name and so a new key, and keeps this.
   */
  at: string;
  /** The change is in a place that changes with no action. The action may not be its cause. */
  ambient?: true;
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
  /**
   * How many elements changed, came or went with no place on the screen in both reads: an item
   * of a closed menu. They are not in `changes`. This is the count of what was left out.
   */
  offScreen: number;
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

/** A separator that is in no key: a key is made of roles and names. */
const AT = '\u0000';

function placeOf(p: Placed): string {
  const [x, y] = p.node.frame ?? [];
  const corner = x === undefined || y === undefined ? '' : `${String(x)},${String(y)}`;
  return [p.parentKey ?? '', p.node.role, corner].join(AT);
}

function who(p: Placed): Pick<Change, 'element' | 'role' | 'name' | 'within' | 'at'> {
  return {
    element: label(p.node),
    role: p.node.role,
    name: p.node.name,
    within: p.parentKey ?? '',
    at: placeOf(p),
  };
}

function byKey(placed: readonly Placed[]): Map<string, Placed> {
  return new Map(placed.map((p) => [p.key, p]));
}

/** True when the element's parent is on the other side, so the element is the top of what moved. */
function isTopOf(p: Placed, other: ReadonlyMap<string, Placed>): boolean {
  return p.parentKey === undefined || other.has(p.parentKey);
}

export function effectOf(
  before: UiNode,
  after: UiNode,
  restless: ReadonlySet<string> = new Set(),
): Effect {
  // Only what is on the screen. An element with no size was there in both reads, so a menu that
  // opened was "no change", and an item put in a closed menu was an effect nobody saw.
  const was = placeShown(before).shown;
  const is = placeShown(after).shown;
  const offScreen = offScreenChanges(before, was, after, is);
  const wasByKey = byKey(was);
  const isByKey = byKey(is);
  const changes: Change[] = [];
  for (const p of was) {
    const now = isByKey.get(p.key);
    if (now === undefined) {
      if (isTopOf(p, isByKey)) {
        changes.push({ kind: ChangeKind.GONE, ...who(p) });
      }
    } else {
      const diff = difference(p.node, now.node);
      if (diff.detail !== undefined) {
        changes.push({ kind: ChangeKind.DIFFERENT, ...who(p), ...diff });
      }
    }
  }
  for (const p of is) {
    if (!wasByKey.has(p.key) && isTopOf(p, wasByKey)) {
      changes.push({ kind: ChangeKind.NEW, ...who(p) });
    }
  }
  const real = changes
    .filter((change) => !isFocusOnly(change))
    .map((change) =>
      restless.has(change.at) || restless.has(change.within)
        ? { ...change, ambient: true as const }
        : change,
    );
  const caused = real.filter((change) => change.ambient === undefined);
  const taker = changes.find((change) => isFocusOnly(change) && tookFocus(change));
  return {
    kind: kindOf(real.length, caused.length),
    changes: real,
    offScreen,
    ...(taker === undefined ? {} : { focusMovedTo: taker.element }),
  };
}

/**
 * How many elements changed, came or went with no place on the screen in both reads.
 * An element that is on the screen in one of the reads is not counted: it is in `changes`.
 */
function offScreenChanges(
  before: UiNode,
  wasShown: readonly Placed[],
  after: UiNode,
  isShown: readonly Placed[],
): number {
  const seen = new Set([...wasShown, ...isShown].map((p) => p.key));
  const was = byKey(place(before).filter((p) => !seen.has(p.key)));
  const is = byKey(place(after).filter((p) => !seen.has(p.key)));
  let count = 0;
  for (const [key, p] of was) {
    const now = is.get(key);
    if (now === undefined || difference(p.node, now.node).detail !== undefined) {
      count += 1;
    }
  }
  for (const key of is.keys()) {
    if (!was.has(key)) {
      count += 1;
    }
  }
  return count;
}

function kindOf(all: number, caused: number): EffectKind {
  if (caused > 0) {
    return EffectKind.CHANGED;
  }
  return all > 0 ? EffectKind.AMBIENT_ONLY : EffectKind.NONE;
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
