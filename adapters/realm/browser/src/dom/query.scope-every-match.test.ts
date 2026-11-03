/**
 * A CSS `scope` that matches several elements searches every one of them (#1663).
 *
 * A list of repeated items with a shared test id (chat messages, table rows, cards) is exactly where
 * an agent writes such a scope. `document.querySelector` searched only the first item, so a `text`
 * check for text in a later item answered `no element matched`, and nothing said the scope matched
 * more than one element. The miss read like an absence.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { runQuery } from './query.js';

const TWO_MESSAGES = `
  <div data-testid="message">Hello</div>
  <div data-testid="message">Done</div>`;

describe('a scope that matches several elements', () => {
  beforeEach(() => {
    document.body.innerHTML = TWO_MESSAGES;
  });

  it('finds text in a match after the first', () => {
    const result = runQuery({ scope: '[data-testid=message]', text: 'Done' });
    expect(result.count).toBe(1);
  });

  it('finds text in a child of a match after the first', () => {
    document.body.innerHTML = `
      <div data-testid="message"><p>Hello</p></div>
      <div data-testid="message"><p>Done</p></div>`;
    const result = runQuery({ scope: '[data-testid=message]', text: 'Done' });
    expect(result.count).toBe(1);
  });

  it('says how many elements the scope matched', () => {
    const result = runQuery({ scope: '[data-testid=message]', text: 'Done' });
    expect(result.scopeMatches).toBe(2);
  });

  it('says how many elements the scope matched on a miss too', () => {
    const result = runQuery({ scope: '[data-testid=message]', text: 'Absent' });
    expect(result.count).toBe(0);
    expect(result.scopeMatches).toBe(2);
    expect(result.scopeMissing).toBeUndefined();
  });

  it('returns every matched element for `self: true`', () => {
    const result = runQuery({ scope: '[data-testid=message]', self: true });
    expect(result.count).toBe(2);
  });

  it('reads `self: true` with text against each matched element', () => {
    const result = runQuery({ scope: '[data-testid=message]', self: true, text: 'Done' });
    expect(result.count).toBe(1);
  });
});

describe('a scope that matches one element', () => {
  it('does not report a match count', () => {
    document.body.innerHTML = `<div data-testid="message">Hello</div>`;
    const result = runQuery({ scope: '[data-testid=message]', text: 'Hello' });
    expect(result.count).toBe(1);
    expect(result.scopeMatches).toBeUndefined();
  });

  it('keeps a ref scope to the one element it names', () => {
    document.body.innerHTML = TWO_MESSAGES;
    const ref = runQuery({ scope: '[data-testid=message]', self: true }).elements[0]?.ref ?? '';
    const result = runQuery({ scope: ref, text: 'Done' });
    expect(result.count).toBe(0);
    expect(result.scopeMatches).toBeUndefined();
  });
});
