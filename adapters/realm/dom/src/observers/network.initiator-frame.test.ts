/**
 * The instrument must not name itself as the cause of what it is measuring.
 *
 * `initiatorStack` answers "which line of your code started this request". It filtered our own
 * frames by FILE NAME, which holds only while our code is served under a path that still says
 * `@reticlehq`. Vite's dependency optimiser emits shared chunks as
 * `/node_modules/.vite/deps/chunk-ABC123.js`, where nothing identifies the package — so our patched
 * `fetch` read as ordinary app code and was reported as the caller.
 *
 * The cost was not a cosmetic mislabel. A field reporter was looking at an RSC request stuck
 * `pending` for 170 seconds, trying to decide whether the app's navigation genuinely hung or
 * Reticle's own tracking had lost it, and the evidence said Reticle initiated the request. Their
 * words: "I could not disambiguate from the available tools."
 */
import { describe, expect, it } from 'vitest';
import { firstAppFrame } from './network.js';

const stack = (...frames: string[]): string => ['Error', ...frames].join('\n');
const APP = '    at handleSubmit (http://localhost:5173/src/checkout.tsx:42:19)';
const AXIOS = '    at dispatchXhr (http://localhost:5173/node_modules/axios/lib/adapter.js:12:3)';
const VITE_CHUNK =
  '    at fetch (http://localhost:5173/node_modules/.vite/deps/chunk-ABC123.js:1413:26)';
const NAMED_RETICLE =
  '    at fetch (http://localhost:5173/node_modules/@reticlehq/browser/dist/observers/network.js:88:5)';

describe('the app own call site wins', () => {
  it('returns the app frame, skipping the dependency frames above it', () => {
    expect(firstAppFrame(stack(VITE_CHUNK, AXIOS, APP))).toContain('checkout.tsx:42:19');
  });

  it('still returns the app frame when our package IS recognisable by name', () => {
    expect(firstAppFrame(stack(NAMED_RETICLE, APP))).toContain('checkout.tsx:42:19');
  });

  it('caps a very long frame rather than carrying it whole', () => {
    const long = `    at x (http://localhost:5173/src/${'a'.repeat(500)}.tsx:1:1)`;
    expect(firstAppFrame(stack(long))?.length).toBeLessThanOrEqual(300);
  });
});

describe('a dependency is named only when there is no app frame at all', () => {
  it('names the library that really started the request', () => {
    expect(
      firstAppFrame(stack(AXIOS)),
      'a fetch that genuinely originates in axios still tells the reader where to look',
    ).toContain('axios');
  });

  it('prefers the app frame over the library when both are present', () => {
    expect(firstAppFrame(stack(AXIOS, APP))).toContain('checkout.tsx');
  });
});

describe('it never blames the observer', () => {
  it('does not return a Vite dep chunk when an app frame exists below it', () => {
    const found = firstAppFrame(stack(VITE_CHUNK, APP)) ?? '';
    expect(
      found,
      'this is the reported case: our own patched fetch read as app code',
    ).not.toContain('chunk-ABC123');
  });

  it('omits the field entirely when every frame is ours', () => {
    expect(
      firstAppFrame(stack(NAMED_RETICLE)),
      'saying nothing beats pointing at the observer — a reader can go and look, a false ' +
        'attribution stops them',
    ).toBeUndefined();
  });

  it('returns nothing for an absent stack', () => {
    expect(firstAppFrame(undefined)).toBeUndefined();
  });
});
