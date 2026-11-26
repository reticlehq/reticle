/**
 * A MATCH can prove that a query cannot match a row that a virtualized list did not render (#2298).
 *
 * A virtual list repeats a control in each row, so one mounted match says nothing about the rows
 * that are not mounted. The proof is containment: the `scope` is a ref to one live element, that
 * element is not inside a virtualized list and does not contain one, and no match is inside one.
 * The page answers `outsideVirtualized: true` only then, and only when the caller asked. All other
 * queries get no field, and the verdict stays `unknown`.
 */
import { afterEach, beforeEach, describe as suite, expect, it, vi } from 'vitest';
import { MatchArg, ReticleCommand, type ElementQuery, type MatchResult } from '@reticlehq/core';
import { createCommandRegistry } from '@/commands/commands.js';
import { matchQuery } from './query.js';
import { refs } from './addressing/refs.js';
import { countUnmountedRows } from './virtualized.js';

/** The field of the answer. It has the same name as the argument that asks for it. */
const FIELD = MatchArg.OUTSIDE_VIRTUALIZED;

/** The control that each row of the list repeats, and that the panel beside the list also has. */
const NOTIFY = '<input type="checkbox" aria-label="Notify me" data-testid="x" />';
const BY_ROLE_AND_NAME = { role: 'checkbox', name: 'Notify me' } as const;
const BY_TESTID = { testid: 'x' } as const;

/** jsdom reports 0 for every layout box, so the geometry has to be stubbed explicitly. */
function box(el: HTMLElement, top: number, height: number): void {
  Object.defineProperty(el, 'offsetTop', { configurable: true, value: top });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 100, height));
}
function scroller(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

/** A scroller that reserves 1700px, with a full-height spacer and three mounted 34px rows. */
function virtualList(parent: HTMLElement): { list: HTMLElement; rows: HTMLElement[] } {
  const list = document.createElement('div');
  const spacer = document.createElement('div');
  list.append(spacer);
  parent.append(list);
  scroller(list, 1700, 560);
  box(spacer, 0, 1700);
  const rows: HTMLElement[] = [];
  for (let i = 0; i < 3; i += 1) {
    const row = document.createElement('div');
    row.innerHTML = NOTIFY;
    spacer.append(row);
    box(row, i * 34, 34);
    rows.push(row);
  }
  return { list, rows };
}

/** A settings panel with one "Notify me" box of its own. */
function panel(parent: Node): HTMLElement {
  const section =
    parent.ownerDocument?.createElement('section') ?? document.createElement('section');
  section.innerHTML = NOTIFY;
  parent.appendChild(section);
  return section;
}

/** The first element under `root` that matches `selector`. */
function only(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (null === found) {
    throw new Error(`fixture: no ${selector}`);
  }
  return found;
}

/** The 4th to 6th arguments are wholePhrase, diagnose and fullText. The proof is the 7th. */
const prove = (query: ElementQuery): ReturnType<typeof matchQuery> =>
  matchQuery(query, undefined, undefined, undefined, undefined, false, true);

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => vi.restoreAllMocks());

suite('matchQuery gives no proof for a query that could match an unmounted row', () => {
  it('sends no field when the caller did not ask', () => {
    virtualList(document.body);
    const scope = refs.refFor(panel(document.body));
    const result = matchQuery({ scope, ...BY_ROLE_AND_NAME });
    expect(result.count).toBe(1);
    expect(result).not.toHaveProperty(FIELD);
  });

  it('sends no field for a query with no scope', () => {
    virtualList(document.body);
    panel(document.body);
    const result = prove(BY_ROLE_AND_NAME);
    expect(result.count).toBe(4);
    expect(result).not.toHaveProperty(FIELD);
  });

  it('sends no field for a CSS scope, which is a pattern and not one live element', () => {
    virtualList(document.body);
    panel(document.body).id = 'settings';
    const result = prove({ scope: '#settings', ...BY_TESTID });
    expect(result.count).toBe(1);
    expect(result).not.toHaveProperty(FIELD);
  });

  it('sends no field when the ref scope is not on the page', () => {
    virtualList(document.body);
    const gone = panel(document.body);
    const scope = refs.refFor(gone);
    gone.remove();
    const result = prove({ scope, ...BY_TESTID });
    expect(result.scopeMissing).toBe(true);
    expect(result).not.toHaveProperty(FIELD);
  });

  it('sends no field when the ref scope is the virtualized list or is inside it', () => {
    const { list, rows } = virtualList(document.body);
    panel(document.body);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('fixture');
    }

    const wholeList = prove({ scope: refs.refFor(list), ...BY_ROLE_AND_NAME });
    expect(wholeList.count).toBe(3);
    expect(wholeList).not.toHaveProperty(FIELD);

    // The case from the review of #2523: the scope is the one mounted row. One match, no proof.
    const oneRow = prove({ scope: refs.refFor(row), ...BY_ROLE_AND_NAME });
    expect(oneRow.count).toBe(1);
    expect(oneRow).not.toHaveProperty(FIELD);

    const rowBox = prove({ scope: refs.refFor(only(row, 'input')), self: true });
    expect(rowBox.count).toBe(1);
    expect(rowBox).not.toHaveProperty(FIELD);

    // No mounted match at all: the scope is still a row of the list, so there is still no proof.
    const noMatch = prove({ scope: refs.refFor(row), testid: 'save' });
    expect(noMatch.count).toBe(0);
    expect(noMatch).not.toHaveProperty(FIELD);
  });

  it('sends no field when the ref scope contains a virtualized list', () => {
    const main = document.createElement('main');
    document.body.append(main);
    virtualList(main);
    panel(main);

    for (const root of [main, document.body]) {
      const result = prove({ scope: refs.refFor(root), ...BY_TESTID });
      expect(result.count).toBe(4);
      expect(result).not.toHaveProperty(FIELD);
    }
  });

  it('sends no field when the scope contains a list and the one mounted match is outside the list', () => {
    // The search covers the list, so a row that is not mounted can hold a second match.
    const main = document.createElement('main');
    document.body.append(main);
    virtualList(main);
    panel(main).insertAdjacentHTML('beforeend', '<button data-testid="save">Save</button>');

    const result = prove({ scope: refs.refFor(main), testid: 'save' });
    expect(result.count).toBe(1);
    expect(result).not.toHaveProperty(FIELD);
  });

  it.each(['open', 'closed'] as const)(
    'sends no field when the ref scope is in a %s shadow root whose host is in a virtualized row',
    (mode) => {
      const { rows } = virtualList(document.body);
      const host = document.createElement('div');
      rows[0]?.append(host);
      const inner = panel(host.attachShadow({ mode }));

      const result = prove({ scope: refs.refFor(inner), ...BY_TESTID });
      expect(result.count).toBe(1);
      expect(result).not.toHaveProperty(FIELD);
    },
  );

  it('sends no field when the ref scope is in a frame that is in a virtualized row', () => {
    const { rows } = virtualList(document.body);
    const frame = document.createElement('iframe');
    rows[0]?.append(frame);
    const body = frame.contentDocument?.body;
    if (body === undefined) {
      throw new Error('fixture: the frame has no document');
    }
    const inner = panel(body);

    const result = prove({ scope: refs.refFor(inner), ...BY_TESTID });
    expect(result.count).toBe(1);
    expect(result).not.toHaveProperty(FIELD);
  });
});

suite('matchQuery proves that a ref scope beside a virtualized list is clear of it', () => {
  it('answers outsideVirtualized for a ref scope outside the list, by role and name and by testid', () => {
    virtualList(document.body);
    const scope = refs.refFor(panel(document.body));
    expect(countUnmountedRows()).toBeGreaterThan(0);

    for (const locator of [BY_ROLE_AND_NAME, BY_TESTID]) {
      const result = prove({ scope, ...locator });
      expect(result.count).toBe(1);
      expect(result.outsideVirtualized).toBe(true);
    }
  });

  it('answers outsideVirtualized for a ref scope with self: true outside the list', () => {
    virtualList(document.body);
    const scope = refs.refFor(only(panel(document.body), 'input'));
    const result = prove({ scope, self: true });
    expect(result.count).toBe(1);
    expect(result.outsideVirtualized).toBe(true);
  });

  it('answers outsideVirtualized with a state, when the match in that state is none', () => {
    virtualList(document.body);
    const scope = refs.refFor(panel(document.body));
    const result = matchQuery(
      { scope, ...BY_TESTID },
      'checked',
      undefined,
      undefined,
      undefined,
      false,
      true,
    );
    expect(result.count).toBe(0);
    expect(result.outsideVirtualized).toBe(true);
  });

  it.each(['open', 'closed'] as const)(
    'answers outsideVirtualized for a ref scope in a %s shadow root whose host is outside the list',
    (mode) => {
      virtualList(document.body);
      const host = document.createElement('div');
      document.body.append(host);
      const inner = panel(host.attachShadow({ mode }));

      const result = prove({ scope: refs.refFor(inner), ...BY_TESTID });
      expect(result.count).toBe(1);
      expect(result.outsideVirtualized).toBe(true);
    },
  );

  it('answers outsideVirtualized for a ref scope in a frame that is outside the list', () => {
    virtualList(document.body);
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const body = frame.contentDocument?.body;
    if (body === undefined) {
      throw new Error('fixture: the frame has no document');
    }
    const inner = panel(body);

    const result = prove({ scope: refs.refFor(inner), ...BY_TESTID });
    expect(result.count).toBe(1);
    expect(result.outsideVirtualized).toBe(true);
  });

  it('answers outsideVirtualized when no container on the page is virtualized', () => {
    const list = document.createElement('div');
    list.innerHTML = NOTIFY + NOTIFY;
    document.body.append(list);
    expect(countUnmountedRows()).toBe(0);

    const result = prove({ scope: refs.refFor(list), ...BY_TESTID });
    expect(result.count).toBe(2);
    expect(result.outsideVirtualized).toBe(true);
  });
});

suite('the match command carries the ask and the proof over the wire', () => {
  const match = (args: Record<string, unknown>): MatchResult => {
    const handler = createCommandRegistry().get(ReticleCommand.MATCH);
    if (handler === undefined) {
      throw new Error('fixture: no match handler');
    }
    return handler(args) as MatchResult;
  };

  it('answers the proof only when the argument is exactly true', () => {
    virtualList(document.body);
    const query = { scope: refs.refFor(panel(document.body)), ...BY_TESTID };

    expect(match({ query, [MatchArg.OUTSIDE_VIRTUALIZED]: true }).outsideVirtualized).toBe(true);
    expect(match({ query })).not.toHaveProperty(FIELD);
    expect(match({ query, [MatchArg.OUTSIDE_VIRTUALIZED]: 'true' })).not.toHaveProperty(FIELD);
    // The other flags of the command do not turn the proof on.
    expect(match({ query, diagnose: true, [MatchArg.FULL_TEXT]: true })).not.toHaveProperty(FIELD);
  });

  it('gives no proof over the wire for a scope inside the list', () => {
    const { rows } = virtualList(document.body);
    panel(document.body);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('fixture');
    }
    const query = { scope: refs.refFor(row), ...BY_TESTID };
    const result = match({ query, [MatchArg.OUTSIDE_VIRTUALIZED]: true });
    expect(result.count).toBe(1);
    expect(result).not.toHaveProperty(FIELD);
  });
});
