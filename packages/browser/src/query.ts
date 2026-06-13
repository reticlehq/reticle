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
} from '@iris/protocol';
import { describe, getStates } from './a11y.js';
import { refs } from './refs.js';

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
        return queryAllByRole(container, value, { hidden: true });
      case QueryBy.TEXT:
        return queryAllByText(container, value, { exact: false });
      case QueryBy.LABEL:
        return queryAllByLabelText(container, value, { exact: false });
      case QueryBy.PLACEHOLDER:
        return queryAllByPlaceholderText(container, value, { exact: false });
      case QueryBy.TESTID:
        return queryAllByTestId(container, value, { exact: false });
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
  if (query.testid !== undefined)
    return queryAllByTestId(container, query.testid, { exact: false });
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

/** Resolve a query to descriptors for the `query` MCP tool. */
export function runQuery(query: ElementQuery): { elements: ElementDescriptor[] } {
  const result = matchQuery(query);
  return { elements: result.elements };
}
