import { describe, it, expect, afterEach } from 'vitest';
import { matchQuery, runQuery } from './query.js';

/**
 * #1781: a node appended straight to `document.documentElement` renders on the page, but
 * rooting the search at `document.body` reported it absent with no hint. The default search
 * root now covers the whole document minus <head>: the appended node is found, while <title>
 * text and other head content still cannot match.
 */
describe('query covers content outside <body>', () => {
  const appended: Element[] = [];

  afterEach(() => {
    for (const el of appended.splice(0)) el.remove();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('finds text in a node appended to documentElement outside <body>', () => {
    document.body.innerHTML = '<main><p>ordinary page text</p></main>';
    const floater = document.createElement('div');
    floater.textContent = 'Overlay notice for the reader';
    document.documentElement.appendChild(floater);
    appended.push(floater);

    const r = runQuery({ text: 'Overlay notice for the reader' });
    expect(r.elements).toHaveLength(1);
  });

  it('control: still matches ordinary body content unchanged', () => {
    document.body.innerHTML = '<main><p>ordinary page text</p></main>';
    const r = runQuery({ text: 'ordinary page text' });
    expect(r.elements).toHaveLength(1);
  });

  it('matches a phrase split across children of a node outside <body>', () => {
    // The review repro: the phrase spans block children of a node appended to documentElement.
    const ov = document.createElement('div');
    ov.innerHTML = '<div>Overlay</div><div>notice</div>';
    document.documentElement.appendChild(ov);
    appended.push(ov);

    expect(matchQuery({ text: 'Overlay notice', matchCase: true }).matched).toBe(true);
  });

  it('a zero-match hint covers content outside <body>', () => {
    const ov = document.createElement('div');
    ov.setAttribute('data-testid', 'overlay-root');
    ov.innerHTML = '<div>Overlay</div><div>notice</div>';
    document.documentElement.appendChild(ov);
    appended.push(ov);

    const missed = matchQuery({ by: 'testid', value: 'not-on-page' });
    expect(missed.matched).toBe(false);
    expect(missed.hint?.presentTestids).toContain('overlay-root');

    const caseMissed = matchQuery({ text: 'overlay notice', matchCase: true });
    expect(caseMissed.matched).toBe(false);
    expect(caseMissed.hint?.caseMiss).toBe('Overlay notice');
  });

  it('a whole-page hint never surfaces <title> text', () => {
    document.head.innerHTML = '<title>Secret Head Words</title>';
    const r = matchQuery({ text: 'secret head words', matchCase: true });
    expect(r.matched).toBe(false);
    expect(r.hint?.caseMiss).toBeUndefined();
    expect(r.hint?.splitText).toBeUndefined();
  });

  it('never matches <title> or other <head> content', () => {
    document.head.innerHTML = '<title>Secret head words</title>';
    document.body.innerHTML = '<main><p>ordinary page text</p></main>';
    const r = runQuery({ text: 'Secret head words' });
    expect(r.elements).toHaveLength(0);
  });
});
