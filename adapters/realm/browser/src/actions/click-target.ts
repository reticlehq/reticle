/**
 * Is a click on this element aimed at nothing a user could click?
 *
 * A `{ text }` target matches any element whose own text contains the value, so it can resolve to
 * a wrapper `div` instead of the button inside it. The click then lands on the wrapper, nothing
 * happens, and the act used to report a clean click (#1356). Retargeting to "the control inside"
 * would be a guess, and an action must not guess, so this only names the case.
 *
 * Not a control means: no interactive role on the element or any ancestor, no `label`/`summary`
 * ancestor (a click there forwards to its control), no `onclick` or `tabindex` on the way up, and
 * no pointer cursor. `cursor` inherits, so one read covers every ancestor. It is also what keeps a
 * framework `<div onClick>` quiet: its handler is invisible here, but it is nearly always styled as
 * clickable.
 *
 * Known gap: the walk stops at a shadow root, so a light-DOM wrapper slotted inside a shadow host's
 * button reads as not a control.
 */
import { ActionType } from '@reticlehq/core';
import { getRole } from '@/dom/a11y.js';
import { INTERACTIVE } from '@/dom/snapshot.js';

const CLICK_FORWARDING = 'label, summary, [onclick], [tabindex]';

export function clickHitsNoControl(el: Element, action: string): boolean {
  if (ActionType.CLICK !== action && ActionType.DBLCLICK !== action) return false;
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    if (INTERACTIVE.has(getRole(node)) || node.matches(CLICK_FORWARDING)) return false;
  }
  return 'pointer' !== getComputedStyle(el).cursor;
}
