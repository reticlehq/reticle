import { isActionTarget } from './realm.js';
import { refs } from './addressing/refs.js';

/**
 * Resolve a scope to its containers. No containers means a scope was GIVEN but resolved to nothing
 * (unmounted, or a selector that matches no element) - the caller must NOT fall back to the whole
 * page, or a scoped query silently widens into a phantom match. `scope === undefined` (no scope)
 * legitimately searches the whole DOCUMENT, rooted at `document.documentElement`: content mounted
 * as a sibling of `<body>` renders on the page and must be reachable (#1781).
 *
 * A CSS scope resolves to EVERY element it matches. A list of repeated items with a shared test id
 * is where an agent writes such a scope, and searching only the first item answered a silent `no`
 * for text in every later item (#1663). A ref names one element.
 */
export function resolveContainers(scope: string | undefined): {
  containers: HTMLElement[];
  scopeMissing: boolean;
} {
  let containers: HTMLElement[] = [];
  if (scope === undefined) {
    containers = [document.documentElement];
  } else {
    // An SVG element is a scope too. `look` hands out refs for SVG links, and the action layer drives
    // them, so refusing one here reported a scope the page plainly has as MISSING - a floor plan whose
    // rooms are `<a href>` inside an `<svg>` could be clicked but never scoped to (#1122). The locators
    // below read only what Element has (attributes, children, text), which is also why `elementsUnder`
    // already walks SVG descendants.
    const byRef = refs.resolve(scope);
    if (isActionTarget(byRef)) {
      containers = [byRef];
    } else {
      try {
        containers = Array.from(document.querySelectorAll<HTMLElement>(scope)).filter(
          isActionTarget,
        );
      } catch {
        // Invalid selector: a given-but-missing scope must not fall back to the page.
      }
    }
  }
  return { containers, scopeMissing: 0 === containers.length };
}

/**
 * The roots a zero-match hint describes: every element the scope matched. A hint WANTS the page's
 * orientation even when the scope is gone, so it falls back to the body (the match path already
 * reported scopeMissing, so this cannot mask it).
 */
export function hintRoots(scope: string | undefined): HTMLElement[] {
  const { containers } = resolveContainers(scope);
  return containers.length > 0 ? containers : [document.body];
}

/** The first answer `find` gives for any of the roots, in document order. */
export function firstIn<T>(
  roots: HTMLElement[],
  find: (root: HTMLElement) => T | undefined,
): T | undefined {
  for (const root of roots) {
    const found = find(root);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** `firstIn` for a finder that answers with a list: the first list that is not empty. */
export function firstListIn<T>(roots: HTMLElement[], find: (root: HTMLElement) => T[]): T[] {
  return (
    firstIn(roots, (root) => {
      const found = find(root);
      return found.length > 0 ? found : undefined;
    }) ?? []
  );
}

/**
 * `<head>` payloads (title, style) are not page content to a whole-page search or hint (#1781).
 * A scoped search names its root explicitly, so nothing is filtered there.
 */
export function pageContent(el: Element, scope: string | undefined): boolean {
  return scope !== undefined || !el.closest('head');
}
