/**
 * Scope resolution and the whole-page search root for DOM queries.
 *
 * Extracted from query.ts (review on #1817): these three are one unit -
 * what part of the document a query searches - and moving them keeps
 * query.ts under the 1000-line lint cap.
 */
import { type ElementQuery } from '@reticlehq/core';
import { isActionTarget } from './realm.js';
import { refs } from './addressing/refs.js';

/**
 * Resolve a scope to its container. A container of `null` means a scope was GIVEN but resolved to
 * nothing (unmounted, or a selector that matches no element) - the caller must NOT fall back to the
 * whole page, or a scoped query silently widens into a phantom match. `scope === undefined` (no scope)
 * legitimately searches the body.
 */
export function resolveContainer(scope: string | undefined): {
  container: HTMLElement | null;
  scopeMissing: boolean;
} {
  if (scope === undefined) return { container: document.body, scopeMissing: false };
  // An SVG element is a scope too. `look` hands out refs for SVG links, and the action layer drives
  // them, so refusing one here reported a scope the page plainly has as MISSING - a floor plan whose
  // rooms are `<a href>` inside an `<svg>` could be clicked but never scoped to (#1122). The locators
  // below read only what Element has (attributes, children, text), which is also why `elementsUnder`
  // already walks SVG descendants.
  const byRef = refs.resolve(scope);
  if (isActionTarget(byRef)) return { container: byRef, scopeMissing: false };
  try {
    const found = document.querySelector(scope);
    if (isActionTarget(found)) return { container: found, scopeMissing: false };
  } catch {
    // invalid selector - treat as a missing scope, never a whole-page search
  }
  return { container: null, scopeMissing: true };
}

/** The root a whole-page query searches and a zero-match hint describes: scope, or DOCUMENT (#1781). */
export function searchRoot(query: ElementQuery): HTMLElement | null {
  if (query.scope !== undefined) return resolveContainer(query.scope).container;
  return document.documentElement; // not body: nodes appended to documentElement render too
}
/** <head> payloads (title, style) are not page content to a whole-page search or hint (#1781). */
export function pageContent(el: Element, scope: string | undefined): boolean {
  return scope !== undefined || null === el.closest('head');
}
