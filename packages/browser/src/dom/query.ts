import {
  queryAllByRole,
  queryAllByText,
  queryAllByLabelText,
  queryAllByPlaceholderText,
  queryAllByTestId,
  queryAllByAltText,
} from '@testing-library/dom';
import {
  ElementState,
  QueryBy,
  type ElementDescriptor,
  type ElementQuery,
  type MatchResult,
  type PresentRegion,
  type QueryEmptyHint,
  type QueryResult,
} from '@syrin/iris-protocol';
import { describe, getStates } from './a11y.js';
import { getCapabilities } from '../registry/capabilities.js';
import { refs } from './refs.js';

const TESTID_ATTR = 'data-testid';
const MAX_PRESENT_TESTIDS = 12;

function resolveContainer(scope: string | undefined): HTMLElement {
  const body = document.body;
  if (scope === undefined) return body;
  const byRef = refs.resolve(scope);
  if (byRef instanceof HTMLElement) return byRef;
  try {
    const found = document.querySelector(scope);
    if (found instanceof HTMLElement) return found;
  } catch {
    // invalid selector — fall through to body
  }
  return body;
}

/** Run the appropriate Testing-Library query for the given ElementQuery. */
function findCandidates(query: ElementQuery): HTMLElement[] {
  const container = resolveContainer(query.scope);
  const by = query.by;
  const value = query.value;

  // Explicit `by`+`value` form.
  if (by !== undefined && value !== undefined) {
    switch (by) {
      case QueryBy.ROLE:
        return queryAllByRole(
          container,
          value,
          query.name !== undefined ? { hidden: true, name: query.name } : { hidden: true },
        );
      case QueryBy.TEXT:
        return queryAllByText(container, value, { exact: false });
      case QueryBy.LABEL:
        return queryAllByLabelText(container, value, { exact: false });
      case QueryBy.PLACEHOLDER:
        return queryAllByPlaceholderText(container, value, { exact: false });
      case QueryBy.TESTID:
        return queryAllByTestId(container, value, { exact: true });
      case QueryBy.ALT:
        return queryAllByAltText(container, value, { exact: false });
      default:
        return [];
    }
  }

  // Structured form (role+name, or any single field).
  if (query.role !== undefined) {
    const options =
      query.name !== undefined
        ? { hidden: true as const, name: query.name }
        : { hidden: true as const };
    return queryAllByRole(container, query.role, options);
  }
  if (query.text !== undefined) return queryAllByText(container, query.text, { exact: false });
  if (query.label !== undefined) {
    return queryAllByLabelText(container, query.label, { exact: false });
  }
  if (query.placeholder !== undefined) {
    return queryAllByPlaceholderText(container, query.placeholder, { exact: false });
  }
  if (query.testid !== undefined) return queryAllByTestId(container, query.testid, { exact: true });
  if (query.alt !== undefined) return queryAllByAltText(container, query.alt, { exact: false });
  return [];
}

function inState(el: Element, state: ElementState): boolean {
  return getStates(el).includes(state);
}

/** Match an element predicate against the live DOM (plan/06). */
export function matchQuery(query: ElementQuery, state?: ElementState): MatchResult {
  let elements: HTMLElement[];
  try {
    elements = findCandidates(query);
  } catch {
    elements = [];
  }
  const filtered = state === undefined ? elements : elements.filter((el) => inState(el, state));
  const descriptors: ElementDescriptor[] = filtered.map((el) => describe(el));
  return { matched: descriptors.length > 0, count: descriptors.length, elements: descriptors };
}

/** Structural clusters of the page — the successor to the raw testid list in zero-match hints. */
function buildPresentRegions(query: ElementQuery): PresentRegion[] {
  const container = resolveContainer(query.scope);
  const regions: PresentRegion[] = [];
  const CONTAINER_ROLES = [
    'list',
    'listbox',
    'grid',
    'table',
    'tree',
    'treegrid',
    'dialog',
    'alertdialog',
    'navigation',
    'main',
    'banner',
    'form',
    'search',
    'menu',
    'menubar',
    'tablist',
  ] as const;
  for (const role of CONTAINER_ROLES) {
    let containers: HTMLElement[];
    try {
      containers = queryAllByRole(container, role, { hidden: true });
    } catch {
      continue;
    }
    for (const el of containers) {
      const name =
        el.getAttribute('aria-label') ??
        el.getAttribute('aria-labelledby') ??
        el.getAttribute('data-testid') ??
        undefined;
      const children = el.querySelectorAll('[role]');
      const sample: string[] = [];
      for (const child of Array.from(children)) {
        if (sample.length >= 3) break;
        const childRole = child.getAttribute('role');
        const childName =
          child.getAttribute('aria-label') ??
          child.getAttribute('data-testid') ??
          child.textContent?.trim().slice(0, 40) ??
          '';
        if (childRole !== null && childName.length > 0) {
          sample.push(`${childRole}[${childName}]`);
        }
      }
      const region: PresentRegion = { role, childCount: children.length, sample };
      if (name !== undefined && name.length > 0) region.name = name;
      regions.push(region);
      if (regions.length >= 10) return regions;
    }
  }
  return regions;
}

/** Diagnostic hint for a zero-match query: what testids ARE present in the searched scope. */
function buildEmptyHint(query: ElementQuery): QueryEmptyHint {
  const container = resolveContainer(query.scope);
  const all = container.querySelectorAll(`[${TESTID_ATTR}]`);
  const present: string[] = [];
  for (const el of Array.from(all)) {
    const id = el.getAttribute(TESTID_ATTR);
    if (id !== null && id.length > 0 && !present.includes(id)) {
      present.push(id);
      if (present.length >= MAX_PRESENT_TESTIDS) break;
    }
  }
  const registered = getCapabilities().testids;
  const knownEmptyState = present.some((id) => registered.includes(id));
  const route = `${location.pathname}${location.search}`;
  return {
    route,
    presentTestids: present,
    presentRegions: buildPresentRegions(query),
    knownEmptyState,
  };
}

/** Resolve a query to descriptors for the `query` MCP tool. */
export function runQuery(query: ElementQuery): QueryResult {
  const result = matchQuery(query);
  if (result.elements.length === 0) {
    return { elements: result.elements, hint: buildEmptyHint(query) };
  }
  return { elements: result.elements };
}
