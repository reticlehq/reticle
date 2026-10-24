import { describe, it, expect, beforeEach } from 'vitest';
import { runQuery } from './query.js';
import type { ElementQuery } from '@reticlehq/core';

/**
 * `by` is typed as the QueryBy union, so TypeScript alone would make this unreachable. It is not:
 * the value arrives as JSON off the wire, where the type system has no vote. The cast is how the
 * test reaches the runtime the product actually has.
 */
const offTheWire = (by: string, value: string): ElementQuery =>
  ({ by, value }) as unknown as ElementQuery;

beforeEach(() => {
  document.body.innerHTML = '';
});

/**
 * The same guarantee, one layer down.
 *
 * The server now rejects an unknown `by` at the schema, but the browser is reachable by other paths
 * — replay, reticle_run, an internal caller — and its `default` arm used to `return []`. "No
 * matches" for a strategy that was never implemented is a false negative the tool invented, and it
 * looks exactly like the element being absent.
 */
describe('an unsupported query strategy throws instead of reporting zero matches', () => {
  it('throws, and names the strategies that do work', () => {
    document.body.innerHTML = '<button data-testid="b">Go</button>';
    expect(() => runQuery(offTheWire('css', 'button'))).toThrow(/unsupported query strategy/i);
    expect(() => runQuery(offTheWire('css', 'button'))).toThrow(/testid/);
  });

  it('a supported strategy still finds the element, so this is not just "everything throws"', () => {
    document.body.innerHTML = '<button data-testid="b">Go</button>';
    expect(runQuery({ by: 'testid', value: 'b' }).count).toBe(1);
  });

  it('finds a fieldset by role and its legend-derived name', () => {
    document.body.innerHTML = '<fieldset><legend>Shipping address</legend><input /></fieldset>';
    expect(runQuery({ by: 'role', value: 'group', name: 'Shipping address' }).count).toBe(1);
  });
});

/**
 * A text CHECK compares case exactly; a text SEARCH does not.
 *
 * `until { kind: "text", contains: "Saved Priya@studio.dev" }` passed against a page reading
 * "Saved priya@studio.dev", so a capitalisation defect could never fail a check. `matchCase` is what
 * the text predicate sends; finding an element by its words stays forgiving.
 */
describe('matchCase', () => {
  it('a case-exact text query does not match different capitalisation', () => {
    document.body.innerHTML = '<p>Saved priya@studio.dev</p>';
    expect(runQuery({ text: 'Saved Priya@studio.dev', matchCase: true }).count).toBe(0);
    expect(runQuery({ text: 'Saved priya@studio.dev', matchCase: true }).count).toBe(1);
  });

  it('a search without it still ignores case', () => {
    document.body.innerHTML = '<p>Saved priya@studio.dev</p>';
    expect(runQuery({ text: 'saved PRIYA@studio.dev' }).count).toBe(1);
  });

  it('holds for a scoped self match across the subtree', () => {
    document.body.innerHTML = '<div id="s"><b>Saved</b> priya</div>';
    expect(runQuery({ text: 'Saved Priya', scope: '#s', self: true, matchCase: true }).count).toBe(
      0,
    );
    expect(runQuery({ text: 'Saved priya', scope: '#s', self: true, matchCase: true }).count).toBe(
      1,
    );
  });
});

/**
 * A page often shows a typographic quote or dash where the check was typed with a plain one. The
 * text is on the screen, so a check that answers `no` reports a defect that does not exist.
 */
describe('typographic quotes and dashes', () => {
  it('a text check matches a curly apostrophe and an en dash with their plain forms', () => {
    document.body.innerHTML = '<p>It\u2019s saved \u2013 done</p>';
    expect(runQuery({ text: "It's saved - done", matchCase: true }).count).toBe(1);
    expect(runQuery({ text: "it's saved - done" }).count).toBe(1);
  });

  it('a check with curly double quotes and an em dash matches the plain text', () => {
    document.body.innerHTML = '<p>Say "hi" - now</p>';
    expect(runQuery({ text: 'Say \u201chi\u201d \u2014 now', matchCase: true }).count).toBe(1);
  });

  it('a role name matches across the same fold', () => {
    document.body.innerHTML = '<button>Don\u2019t save</button>';
    expect(runQuery({ by: 'role', value: 'button', name: "Don't save" }).count).toBe(1);
  });
});

describe('label queries prefer exact accessible names', () => {
  it('does not include a longer button name when an exact control label exists', () => {
    document.body.innerHTML =
      '<label for="result">Generation result</label>' +
      '<input id="result" type="text" />' +
      '<button>Record generation result</button>';

    const result = runQuery({ label: 'Generation result' });

    expect(result.count).toBe(1);
    expect(result.elements[0]?.role).toBe('textbox');
    expect(result.elements[0]?.name).toBe('Generation result');
  });

  it('keeps substring matching when no exact accessible name exists', () => {
    document.body.innerHTML = '<button>Record generation result</button>';

    expect(runQuery({ label: 'Generation result' }).count).toBe(1);
  });

  it('preserves multiple exact matches as an explicit ambiguity', () => {
    document.body.innerHTML = '<button>Save</button><input aria-label="Save" />';

    const result = runQuery({ label: 'save' });

    expect(result.count).toBe(2);
    expect(result.elements.map(({ name }) => name)).toEqual(['Save', 'Save']);
  });

  it('normalises case, whitespace and canonical Unicode equivalence', () => {
    document.body.innerHTML =
      '<input aria-label="Generation   Result" />' + '<button aria-label="café">Record</button>';

    expect(runQuery({ label: 'generation result' }).count).toBe(1);
    expect(runQuery({ by: 'label', value: 'café' }).count).toBe(1);
    expect(runQuery({ label: 'cafe' }).count).toBe(0);
  });

  it('uses computed names from native labels and aria-labelledby', () => {
    document.body.innerHTML =
      '<span id="caption">Account email</span>' +
      '<label for="email">Email address</label><input id="email" />' +
      '<input aria-labelledby="caption" />' +
      '<button>Send account email</button>';

    expect(runQuery({ label: 'email address' }).count).toBe(1);
    expect(runQuery({ by: 'label', value: 'ACCOUNT EMAIL' }).count).toBe(1);
  });

  it('keeps label resolution inside the requested scope', () => {
    document.body.innerHTML =
      '<section id="one"><input aria-label="Save" /></section>' +
      '<section id="two"><input aria-label="Save" /></section>';

    const result = runQuery({ label: 'Save', scope: '#two' });

    expect(result.count).toBe(1);
    expect(result.elements[0]?.name).toBe('Save');
  });
});
