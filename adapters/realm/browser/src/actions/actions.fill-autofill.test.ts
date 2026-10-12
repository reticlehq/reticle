import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';
import { isAutofillSafeTarget } from './value-input.js';

/*
 * From the field: in a signed macOS app (WKWebView), focusing a password field raises the system
 * saved-password panel, and every replayed sign-in step raised it. A password fill in WebKit sets the
 * value and fires the events frameworks listen to WITHOUT the focus. Nothing else changes.
 */
const WKWEBVIEW =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const SAFARI = `${WKWEBVIEW} Version/17.4 Safari/605.1.15`;
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

const field = (html: string): HTMLInputElement => {
  document.body.innerHTML = html;
  const el = document.querySelector('input');
  if (null === el) throw new Error('no input');
  return el;
};

describe('which fills skip the focus', () => {
  it('a password field in WebKit (a WKWebView, Safari)', () => {
    const pw = field('<input type="password">');
    expect(isAutofillSafeTarget(pw, WKWEBVIEW)).toBe(true);
    expect(isAutofillSafeTarget(pw, SAFARI)).toBe(true);
    const named = field('<input type="text" autocomplete="current-password">');
    expect(isAutofillSafeTarget(named, WKWEBVIEW)).toBe(true);
  });

  it('never a plain field, and never in Blink', () => {
    expect(isAutofillSafeTarget(field('<input type="email">'), WKWEBVIEW)).toBe(false);
    expect(isAutofillSafeTarget(field('<input type="password">'), CHROME)).toBe(false);
  });
});

describe('a password fill in WebKit', () => {
  beforeEach(() => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WKWEBVIEW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('leaves the field unfocused, and the app still hears the value', async () => {
    document.body.innerHTML =
      '<form><input type="password" name="pw"><button>Sign in</button></form>';
    const input = document.querySelector('input') as HTMLInputElement;
    const heard: string[] = [];
    input.addEventListener('input', () => heard.push(input.value));
    input.addEventListener('change', () => heard.push(`change:${input.value}`));
    const r = await executeAction(refs.refFor(input), 'fill', { value: 's3cret!' });
    expect(document.activeElement).not.toBe(input);
    expect(heard).toEqual(['s3cret!', 'change:s3cret!']);
    expect(new FormData(input.form as HTMLFormElement).get('pw')).toBe('s3cret!');
    expect(r.effect).toMatchObject({ valueChanged: true, autofillSafe: true });
  });

  it('still focuses a field that is not a password', async () => {
    document.body.innerHTML = '<input type="email">';
    const input = document.querySelector('input') as HTMLInputElement;
    const r = await executeAction(refs.refFor(input), 'fill', { value: 'a@b.c' });
    expect(document.activeElement).toBe(input);
    expect(r.effect).not.toHaveProperty('autofillSafe');
  });
});
