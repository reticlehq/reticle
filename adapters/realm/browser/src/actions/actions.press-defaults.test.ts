/**
 * A pressed key does what the same key does in a browser.
 *
 * A synthetic key event has no default action: the browser does not activate a button on Enter, does
 * not submit a form on Enter in a field, does not click a button on Space, and does not move focus on
 * Tab. So `press` reached the app and nothing followed, and a correct app was verified `no`. Field
 * reports: "press Enter on a focused native button does not activate it", and an Enter in a form
 * field that did not submit it (#1519, flow replay).
 *
 * Each default runs only where the browser runs it, and only when the app did not cancel the key.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (null === el) {
    throw new Error(`fixture: #${id}`);
  }
  return el as T;
};

const press = (el: Element, key: string, extra: Record<string, unknown> = {}) =>
  executeAction(refs.refFor(el), 'press', { key, ...extra });

const clicksOn = (el: HTMLElement): (() => number) => {
  let n = 0;
  el.addEventListener('click', () => {
    n += 1;
  });
  return () => n;
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Enter', () => {
  it('activates a native button once', async () => {
    document.body.innerHTML = '<button id="b" type="button">Go</button>';
    const clicks = clicksOn(byId('b'));
    await press(byId('b'), 'Enter');
    expect(clicks()).toBe(1);
  });

  it('does nothing when the app cancels the keydown', async () => {
    document.body.innerHTML = '<button id="b" type="button">Go</button>';
    const b = byId('b');
    b.addEventListener('keydown', (e) => e.preventDefault());
    const clicks = clicksOn(b);
    await press(b, 'Enter');
    expect(clicks()).toBe(0);
  });

  it('follows a link', async () => {
    document.body.innerHTML = '<a id="l" href="#next">Next</a>';
    const clicks = clicksOn(byId('l'));
    await press(byId('l'), 'Enter');
    expect(clicks()).toBe(1);
  });

  it('submits the form of a text field once', async () => {
    document.body.innerHTML =
      '<form id="f"><input id="q" name="q"><button type="submit">Search</button></form>';
    let submits = 0;
    byId('f').addEventListener('submit', (e) => {
      e.preventDefault();
      submits += 1;
    });
    await press(byId('q'), 'Enter');
    expect(submits).toBe(1);
  });

  it('does not submit from a textarea, where Enter is a new line', async () => {
    document.body.innerHTML =
      '<form id="f"><textarea id="t"></textarea><button type="submit">Send</button></form>';
    let submits = 0;
    byId('f').addEventListener('submit', (e) => {
      e.preventDefault();
      submits += 1;
    });
    await press(byId('t'), 'Enter');
    expect(submits).toBe(0);
  });

  it('does nothing on an element the browser gives no Enter default', async () => {
    document.body.innerHTML = '<div id="d" role="button" tabindex="0">Go</div>';
    const clicks = clicksOn(byId('d'));
    await press(byId('d'), 'Enter');
    expect(clicks()).toBe(0);
  });
});

describe('Space', () => {
  it('activates a native button once', async () => {
    document.body.innerHTML = '<button id="b" type="button">Go</button>';
    const clicks = clicksOn(byId('b'));
    await press(byId('b'), ' ');
    expect(clicks()).toBe(1);
  });

  it('toggles a checkbox', async () => {
    document.body.innerHTML = '<input id="c" type="checkbox">';
    await press(byId('c'), ' ');
    expect(byId<HTMLInputElement>('c').checked).toBe(true);
  });

  it('does not click a link, which Space scrolls past in a browser', async () => {
    document.body.innerHTML = '<a id="l" href="#next">Next</a>';
    const clicks = clicksOn(byId('l'));
    await press(byId('l'), ' ');
    expect(clicks()).toBe(0);
  });

  it('is held to the destructive-action rule, as Enter and a click are', async () => {
    document.body.innerHTML = '<button id="b" type="button">Delete account</button>';
    const clicks = clicksOn(byId('b'));
    await expect(press(byId('b'), ' ')).rejects.toThrow(/destructive/);
    expect(clicks()).toBe(0);
  });
});

describe('Tab', () => {
  it('moves focus to the next control, and Shift+Tab moves it back', async () => {
    document.body.innerHTML =
      '<input id="a"><button id="skip" disabled>x</button><span tabindex="-1">no</span><input id="c">';
    byId('a').focus();
    await press(byId('a'), 'Tab');
    expect(document.activeElement?.id).toBe('c');
    await press(byId('c'), 'Tab', { modifiers: ['Shift'] });
    expect(document.activeElement?.id).toBe('a');
  });

  it('leaves focus where it is when the app cancels the keydown', async () => {
    document.body.innerHTML = '<input id="a"><input id="c">';
    const a = byId('a');
    a.addEventListener('keydown', (e) => e.preventDefault());
    a.focus();
    await press(a, 'Tab');
    expect(document.activeElement?.id).toBe('a');
  });
});
