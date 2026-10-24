/**
 * A harness building a map of the app needs every control's stable identity, and the visible name is
 * not one: "Open 2" becomes "Open 3" with the next issue, and a row is named by its own data. The test
 * id is. It stays out of the default tree on purpose (it cost +15% on the most-called read), so a
 * caller that wants it asks: `ids: true` adds `[testid=…]` to the lines of controls that carry one,
 * and changes nothing else.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { buildSnapshot } from './snapshot.js';
import { registerAdapter } from '@/registry/stores/adapters.js';

afterEach(() => {
  document.body.innerHTML = '';
});

const PAGE =
  '<button data-testid="issues-open">Open 2</button><button>Fixed 0</button><a href="/runs" data-testid="nav-runs">Runs</a>';

describe('a snapshot that names each control by its test id', () => {
  it('adds the test id to the line of every control that carries one', () => {
    document.body.innerHTML = PAGE;
    const tree = buildSnapshot({ mode: 'interactive', ids: true }).tree;
    expect(tree).toMatch(/- button "Open 2" \(ref=e\d+\) \[testid=issues-open\]/);
    expect(tree).toMatch(/- link "Runs" \(ref=e\d+\) \[testid=nav-runs\]/);
    expect(tree).toMatch(/- button "Fixed 0" \(ref=e\d+\)$/m);
  });

  it('leaves the default tree exactly as it was', () => {
    document.body.innerHTML = PAGE;
    const plain = buildSnapshot({ mode: 'interactive' }).tree;
    expect(plain).not.toContain('testid=');
    const withIds = buildSnapshot({ mode: 'interactive', ids: true }).tree;
    expect(withIds.replace(/ \[testid=[^\]]+\]/g, '')).toBe(plain);
  });

  it('names the component of a control with no test id, so it keeps one identity across renders', () => {
    registerAdapter({
      name: 'ids-fake',
      identify: (el: Element) => {
        const name = el.closest('[data-component]')?.getAttribute('data-component');
        return null === name || name === undefined ? null : { componentStack: [name] };
      },
    });
    document.body.innerHTML =
      '<div data-component="PageCard"><button>/runs, 0 flows</button></div><button data-testid="x">X</button>';
    const tree = buildSnapshot({ mode: 'interactive', ids: true }).tree;
    expect(tree).toMatch(/- button "\/runs, 0 flows" \(ref=e\d+\) \[component=PageCard\]/);
    expect(tree).toMatch(/- button "X" \(ref=e\d+\) \[testid=x\]$/m);
  });

  it('names where a control is written, when the framework says, test id or not', () => {
    registerAdapter({
      name: 'ids-src',
      identify: (el: Element) => {
        const at = el.closest('[data-src]')?.getAttribute('data-src');
        if (null === at || at === undefined) return null;
        const [file = '', line = '0'] = at.split(':');
        return { componentStack: ['Card'], source: { file, line: Number(line) } };
      },
    });
    document.body.innerHTML =
      '<div data-src="src/card.tsx:12"><button data-testid="open">Open</button><button>Close</button></div>';
    const tree = buildSnapshot({ mode: 'interactive', ids: true }).tree;
    expect(tree).toMatch(/- button "Open" \(ref=e\d+\) \[testid=open\] \[src=src\/card\.tsx:12\]/);
    expect(tree).toMatch(
      /- button "Close" \(ref=e\d+\) \[component=Card\] \[src=src\/card\.tsx:12\]/,
    );
    expect(buildSnapshot({ mode: 'interactive' }).tree).not.toContain('src=');
  });
});
