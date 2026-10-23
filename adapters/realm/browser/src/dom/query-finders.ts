import { DATA_RETICLE_SOURCE_ATTR, QueryBy, type ElementQuery } from '@reticlehq/core';
import { isInput, isSelect, isTextArea } from './realm.js';
import { getAccessibleName, getRole } from './a11y.js';
import { isVisible } from './visibility.js';
import { identifyComponent } from '@/registry/stores/adapters.js';
import { readTestId, testIdSelector } from './addressing/testid-attr.js';
import {
  exactVisibleText,
  fuzzyVisibleText,
  comparableText,
  paintedCase,
  textMatches,
} from './text-match.js';

const SOURCE_ATTR = DATA_RETICLE_SOURCE_ATTR;
/** Bound the fiber-walk fallback so a component-name query can't scan an unbounded DOM. */
const MAX_COMPONENT_CANDIDATES = 2000;
/** Likely-actionable elements considered when resolving a component anchor without a source stamp. */
/** A function, not a constant: the test-id attribute is configured at connect, after this module loads. */
const componentCandidateSelector = (): string =>
  `[${SOURCE_ATTR}], ${testIdSelector()}, button, a, input, select, textarea, [role]`;

/**
 * Every candidate a semantic locator may match: the container ITSELF first, then its descendants.
 *
 * The container's own text, role or name was matched by every engine this replaces - a scoped
 * `{ text: "Saved" }` against `<div id="status">Saved</div>` found #status itself - so dropping
 * the root here would turn exactly those scoped queries into silent zero-match answers: the worst
 * failure mode, indistinguishable from the element being absent. `self: true` stays the way to
 * reach an UNLABELLED root (it skips the predicate entirely); this keeps a root that DOES satisfy
 * the predicate findable without a second spelling.
 */
export function elementsUnder(container: HTMLElement): HTMLElement[] {
  // Embedded roots include ShadowRoots, which are DocumentFragments: they have no attributes or
  // tag to match on, so only a true Element root joins the candidates.
  const self = Node.ELEMENT_NODE === container.nodeType ? [container] : [];
  return [...self, ...Array.from(container.querySelectorAll<HTMLElement>('*'))];
}

/** Tags whose text content is never rendered, however visible the element computes. */
const NON_RENDERED_TAGS: readonly string[] = ['script', 'style', 'template', 'noscript'];

export function isNonRendered(el: Element): boolean {
  return NON_RENDERED_TAGS.includes(el.tagName.toLowerCase());
}

function directText(el: Element): string {
  if (isInput(el)) {
    const type = el.type.toLowerCase();
    if ('submit' === type || 'button' === type || 'reset' === type) {
      return el.value;
    }
  }
  if (isNonRendered(el)) {
    return '';
  }
  return Array.from(el.childNodes)
    .filter((node) => Node.TEXT_NODE === node.nodeType)
    .map((node) => node.textContent ?? '')
    .join('');
}

/**
 * Elements whose accessible name comes from author-supplied naming rather than free subtree
 * content - the set `by: label` addresses.
 *
 * Form controls plus anything explicitly named with aria-label/aria-labelledby covers the common
 * case. `button`, `meter`, `output` and `progress` are included because their names arrive on
 * attributes (`value`) or from their caption, which is precisely what a label query is looking
 * for; leaving them out would silently drop buttons from label searches.
 */
function semanticNameTarget(el: Element): boolean {
  if (isInput(el) || isTextArea(el) || isSelect(el)) {
    return true;
  }
  const tag = el.tagName.toLowerCase();
  return (
    'button' === tag ||
    'meter' === tag ||
    'output' === tag ||
    'progress' === tag ||
    el.hasAttribute('aria-label') ||
    el.hasAttribute('aria-labelledby')
  );
}

/**
 * Resolve an element by its SOURCE location - the precise, granular auto-anchor. The babel plugin
 * stamps `data-reticle-source="file:line:column"` on host elements, so a line-level starts-with match
 * pins the exact JSX element with a single fast attribute selector (no fiber walk). Column is
 * ignored so a small column drift doesn't unbind the anchor.
 */
function findBySource(
  container: HTMLElement,
  source: { file: string; line: number },
): HTMLElement[] {
  const prefix = `${source.file}:${source.line}:`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  try {
    return Array.from(container.querySelectorAll<HTMLElement>(`[${SOURCE_ATTR}^="${prefix}"]`));
  } catch {
    return [];
  }
}

/**
 * Resolve by component display name when no source stamp is available: scan a bounded set of
 * likely-actionable elements and keep those whose NEAREST enclosing component (via the registered
 * framework adapter) matches. Coarser than source (one component renders many hosts) - used as a
 * fallback / for frameworks without a source plugin.
 */
function findByComponentName(container: HTMLElement, component: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  let scanned = 0;
  for (const el of Array.from(
    container.querySelectorAll<HTMLElement>(componentCandidateSelector()),
  )) {
    if (scanned >= MAX_COMPONENT_CANDIDATES) {
      break;
    }
    scanned += 1;
    const info = identifyComponent(el);
    if (info !== null && info.componentStack[0] === component) {
      out.push(el);
    }
  }
  return out;
}

/** Auto-anchor resolution: source (precise) first, then component name (coarse fallback). */
function findByComponent(container: HTMLElement, query: ElementQuery): HTMLElement[] {
  if (query.source !== undefined) {
    const bySource = findBySource(container, query.source);
    if (bySource.length > 0) {
      return bySource;
    }
  }
  if (query.component !== undefined && query.component.length > 0) {
    return findByComponentName(container, query.component);
  }
  return [];
}

/**
 * Does an element whose computed role is `actual` satisfy a query for `queried`?
 *
 * `searchbox` is an ARIA sub-role of `textbox`. A standard search input computes as `searchbox`
 * (per HTML-AAM), which matches `{ role: "searchbox" }`. A `{ role: "textbox" }` query must
 * keep matching it as well, so existing flows and recorded steps using `textbox` continue to match.
 */
function matchesRole(actual: string, queried: string): boolean {
  if (actual === queried) {
    return true;
  }
  if ('textbox' === queried && 'searchbox' === actual) {
    return true;
  }
  return false;
}

const OPTION_ROLE = 'option';
const HTML_OPTION_TAG = 'option';
const HTML_SELECT_TAG = 'select';
/**
 * The visually-hidden bubble. A control a person can use is larger than a 1×1 clip; that size is
 * the convention libraries use to keep a native select out of the page.
 */
const VISUALLY_HIDDEN_MAX_PX = 1;

/** A native `<option>` whose owning `<select>` is not a control a person can click. */
export function isHiddenNativeOption(el: HTMLElement): boolean {
  if (HTML_OPTION_TAG !== el.localName) {
    return false;
  }
  const select = el.closest(HTML_SELECT_TAG);
  if (!isSelect(select)) {
    return false;
  }
  if (!isVisible(select)) {
    return true;
  }
  return isVisuallyHiddenBox(select);
}

/**
 * The bubble's own shape: a measured box no larger than 1×1. A 0×0 box is not enough, because a
 * closed `<select>` with no layout yet (and every node in jsdom) measures 0×0 and is still the
 * control a person uses, so its options keep counting for role queries.
 */
function isVisuallyHiddenBox(select: HTMLSelectElement): boolean {
  const box = select.getBoundingClientRect();
  return (
    box.width > 0 &&
    box.height > 0 &&
    box.width <= VISUALLY_HIDDEN_MAX_PX &&
    box.height <= VISUALLY_HIDDEN_MAX_PX
  );
}

/**
 * Prefer a visible actionable option over a hidden native duplicate.
 *
 * Radix (and the same shape elsewhere) keeps a native `<option>` inside a 1×1 clipped `<select>`
 * so a form can submit, and paints the choice a person clicks as `role="option"` in a portal.
 * Both compute the same accessible name. The native node is first in the document, so a role+name
 * anchor resolved to it, replay dispatched a click, and the selected value never moved — the
 * handler lives on the portal node. The visibility walk catches the bubble only by its sr-only
 * clip; a bare 1×1 box that does not clip still reads `visible`, and so do its options, which have
 * no layout box of their own.
 *
 * Drop every native `<option>` whose `<select>` is not a control a person can use. When a portal
 * duplicate exists it is the one replay should target; when the dropdown is closed and only the
 * hidden native node remains, resolving or clicking it still cannot change the selection, so the
 * match is refused rather than reported as success. A real `<select>` the user can see is unchanged.
 *
 * Returns the original array when nothing is dropped, so a unique match keeps its identity.
 */
function preferVisibleActionableOption(role: string, matches: HTMLElement[]): HTMLElement[] {
  if (OPTION_ROLE !== role) {
    return matches;
  }
  const kept = matches.filter((el) => !isHiddenNativeOption(el));
  return kept.length === matches.length ? matches : kept;
}

/**
 * Role + name, matched with the same local accessibility engine used to describe results.
 *
 * This intentionally makes Reticle's reported role and name the source of truth. If an element is
 * described as `textbox "Search User"`, the resolver must accept that exact pair, not a different
 * role or name from a second library.
 */
export function queryByRoleAndName(
  container: HTMLElement,
  role: string,
  name: string | undefined,
): HTMLElement[] {
  const matched = elementsUnder(container).filter(
    (el) =>
      matchesRole(getRole(el), role) &&
      (name === undefined || exactVisibleText(getAccessibleName(el), name)),
  );
  return preferVisibleActionableOption(role, matched);
}

/**
 * A case-exact check holds on the DOM case or on the case CSS paints (#1782): with
 * `text-transform: uppercase` the screen shows "SAVED" while the DOM holds "Saved". The style is
 * read only after a case-blind hit, so a page with no near match pays nothing.
 */
function queryByText(container: HTMLElement, value: string, query: ElementQuery): HTMLElement[] {
  return elementsUnder(container).filter((el) => {
    const own = directText(el);
    if (textMatches(own, query, value)) {
      return true;
    }
    if (true !== query.matchCase || !fuzzyVisibleText(own, value)) {
      return false;
    }
    const painted = paintedCase(el, own);
    return painted !== undefined && textMatches(painted, query, value);
  });
}

function queryByLabel(container: HTMLElement, value: string): HTMLElement[] {
  const expected = comparableText(value).toLowerCase();
  const exact: HTMLElement[] = [];
  const fuzzy: HTMLElement[] = [];

  for (const el of elementsUnder(container)) {
    if (!semanticNameTarget(el)) {
      continue;
    }
    const name = comparableText(getAccessibleName(el)).toLowerCase();
    if (!name.includes(expected)) {
      continue;
    }
    (name === expected ? exact : fuzzy).push(el);
  }

  return exact.length > 0 ? exact : fuzzy;
}

function queryByPlaceholder(container: HTMLElement, value: string): HTMLElement[] {
  return elementsUnder(container).filter((el) => {
    const placeholder = el.getAttribute('placeholder');
    return placeholder !== null && fuzzyVisibleText(placeholder, value);
  });
}

function queryByTestId(container: HTMLElement, value: string): HTMLElement[] {
  return elementsUnder(container).filter((el) => readTestId(el) === value);
}

function queryByAlt(container: HTMLElement, value: string): HTMLElement[] {
  return elementsUnder(container).filter((el) => {
    const alt = el.getAttribute('alt');
    return alt !== null && fuzzyVisibleText(alt, value);
  });
}

/** Run the appropriate local query against ONE root, light DOM or a shadow root. */
export function findIn(container: HTMLElement, query: ElementQuery): HTMLElement[] {
  const by = query.by;
  const value = query.value;

  // Explicit `by`+`value` form.
  if (by !== undefined && value !== undefined) {
    switch (by) {
      case QueryBy.ROLE:
        return queryByRoleAndName(container, value, query.name);
      case QueryBy.TEXT:
        return queryByText(container, value, query);
      case QueryBy.LABEL:
        return queryByLabel(container, value);
      case QueryBy.PLACEHOLDER:
        return queryByPlaceholder(container, value);
      case QueryBy.TESTID:
        return queryByTestId(container, value);
      case QueryBy.ALT:
        return queryByAlt(container, value);
      case QueryBy.COMPONENT:
        // value is the component name;.source (if present) still takes precedence inside.
        return findByComponent(container, { ...query, component: query.component ?? value });
      default:
        // THROW, never `return []`. An unsupported strategy answering "no matches" is
        // indistinguishable from the element genuinely being absent, so `by:'css'` - the first thing
        // anyone arriving from Playwright reaches for - reported a page with a <body> as empty. The
        // server now rejects unknown strategies at the schema; this is the same guarantee for every
        // other path in (replay, reticle_run, an internal caller), because a false negative invented
        // by the tool is the exact failure this product exists to prevent.
        throw new Error(
          `unsupported query strategy '${String(by)}' - use one of: ${Object.values(QueryBy).join(', ')}`,
        );
    }
  }

  // Auto-anchor (component / source) - checked before the role/text fields so a query carrying
  // both a component anchor and an incidental role resolves by the more durable anchor.
  if (query.component !== undefined || query.source !== undefined) {
    return findByComponent(container, query);
  }

  // Structured form (role+name, or any single field). Same round-trip guarantee as the by+value
  // spelling above - the two forms must not disagree about what is findable.
  if (query.role !== undefined) {
    return queryByRoleAndName(container, query.role, query.name);
  }
  if (query.text !== undefined) {
    return queryByText(container, query.text, query);
  }
  if (query.label !== undefined) {
    return queryByLabel(container, query.label);
  }
  if (query.placeholder !== undefined) {
    return queryByPlaceholder(container, query.placeholder);
  }
  if (query.testid !== undefined) {
    return queryByTestId(container, query.testid);
  }
  if (query.alt !== undefined) {
    return queryByAlt(container, query.alt);
  }
  return [];
}
