import { ActionType } from '@reticlehq/core';
import { type ActionTarget, isInput } from '@/dom/realm.js';

/** Custom toggles (`<button role="checkbox" aria-checked>`) that check/uncheck drive by clicking. */
const ARIA_TOGGLE_ROLES: ReadonlySet<string> = new Set(['checkbox', 'switch']);
const ARIA_CHECKED = 'aria-checked';

export const isAriaToggle = (el: Element): boolean =>
  !isInput(el) && ARIA_TOGGLE_ROLES.has(el.getAttribute('role') ?? '');

export const ariaChecked = (el: Element): boolean => 'true' === el.getAttribute(ARIA_CHECKED);

/**
 * An ARIA toggle has no native activation behaviour: the APP flips `aria-checked` in its click
 * handler. Read once the action has settled; a click the app ignored is not a check.
 */
export function assertAriaToggleLanded(el: Element, action: string, skipped: boolean): void {
  if (skipped || !isAriaToggle(el)) return;
  if (action !== ActionType.CHECK && action !== ActionType.UNCHECK) return;
  const wanted = action === ActionType.CHECK;
  if (ariaChecked(el) === wanted) return;
  throw new Error(
    `${action} clicked the ${el.getAttribute('role') ?? ''} but ${ARIA_CHECKED} is still "${String(!wanted)}" — the app did not toggle it`,
  );
}

/**
 * A check/uncheck whose requested state the element already reads as, so nothing will be dispatched.
 *
 * ONE predicate, read twice — the dispatch branch decides not to click, the effect reports that it
 * did not. Two copies of this rule could disagree, and a disagreement here is precisely the false
 * green: an act that reports it drove a control it never touched.
 */
export function alreadyAtCheckedState(el: ActionTarget, action: string): boolean {
  if (action !== ActionType.CHECK && action !== ActionType.UNCHECK) return false;
  const wanted = action === ActionType.CHECK;
  if (isInput(el)) return el.checked === wanted;
  return isAriaToggle(el) && ariaChecked(el) === wanted;
}
