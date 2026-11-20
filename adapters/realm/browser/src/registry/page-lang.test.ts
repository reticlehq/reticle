import { afterEach, describe, expect, it } from 'vitest';
import { TRANSPORT_LIMITS } from '@reticlehq/core/page';
import { pageLang } from './declared-platform.js';

/**
 * The page language that HELLO carries (#2278). A tag longer than the wire cap would make the bridge
 * refuse the whole HELLO, so the SDK sends no tag instead.
 */
describe('pageLang', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('lang');
  });

  it('reads the lang attribute of <html>', () => {
    document.documentElement.lang = 'ar';
    expect(pageLang()).toBe('ar');
  });

  it('is undefined when the page sets no language', () => {
    expect(pageLang()).toBeUndefined();
  });

  it('is undefined for a blank lang attribute', () => {
    document.documentElement.lang = '   ';
    expect(pageLang()).toBeUndefined();
  });

  it('is undefined for a tag longer than the wire cap, so HELLO is not refused', () => {
    document.documentElement.lang = 'x'.repeat(TRANSPORT_LIMITS.MAX_LANG_LENGTH + 1);
    expect(pageLang()).toBeUndefined();
  });
});
