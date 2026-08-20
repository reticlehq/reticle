import { describe, it, expect, afterEach } from 'vitest';
import { isReticleOverlay, isIgnored, isReticleUi } from './dom-ignore.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('dom-ignore — Reticle-owned UI is excluded from observation/snapshot', () => {
  it('treats the annotator (data-reticle-mark) as Reticle overlay, not app content', () => {
    // The annotator mounts by default with the presenter and tags every node with data-reticle-mark.
    // If it is not recognized here, its "Flag a bug" button and highlight-box mutations leak into the
    // snapshot and the DOM/animation event streams as if the APP rendered them.
    document.body.innerHTML = '<button data-reticle-mark="fab">Flag a bug</button>';
    const fab = document.querySelector('[data-reticle-mark]');
    expect(fab).not.toBeNull();
    if (null === fab) return;
    expect(isReticleOverlay(fab)).toBe(true);
    expect(isIgnored(fab)).toBe(true);
  });

  it('still recognizes the presenter overlay/cursor/hud/glow', () => {
    for (const attr of [
      'data-reticle-overlay',
      'data-reticle-cursor',
      'data-reticle-hud',
      'data-reticle-glow',
    ]) {
      const el = document.createElement('div');
      el.setAttribute(attr, '');
      document.body.appendChild(el);
      expect(isReticleOverlay(el)).toBe(true);
    }
  });

  it('does NOT ignore an ordinary app element', () => {
    document.body.innerHTML = '<button>Real app button</button>';
    const btn = document.querySelector('button');
    expect(btn).not.toBeNull();
    if (null === btn) return;
    expect(isReticleOverlay(btn)).toBe(false);
    expect(isIgnored(btn)).toBe(false);
  });
});

/**
 * A marker on <html> must not make the whole document Reticle's own UI.
 *
 * `isReticleUi` walks ancestors for any `data-reticle*` attribute, and the annotator sets
 * `data-reticle-mark-active` on the documentElement to drive its crosshair cursor. Those two meet on
 * `<html>`: while annotate mode is live, EVERY element on the page has a `data-reticle*` ancestor,
 * so every element answers true.
 *
 * That is not cosmetic. `occlusion.ts` asks this question about the topmost element at a point and
 * returns null — "nothing to report" — when the answer is yes, so with annotate on, occlusion
 * detection silently stops working for the entire page. Occluded controls are a bug class Reticle
 * advertises catching, and it would have been reported clean.
 *
 * Reticle's own UI always lives INSIDE body, so the document scaffolding is not part of the answer.
 */
describe('the page is not Reticle UI just because Reticle marked the document', () => {
  it('a plain element stays page content while annotate mode is active', () => {
    document.documentElement.setAttribute('data-reticle-mark-active', '');
    const el = document.createElement('button');
    document.body.appendChild(el);
    try {
      expect(isReticleUi(el), 'a page button is not Reticle UI').toBe(false);
    } finally {
      document.documentElement.removeAttribute('data-reticle-mark-active');
      el.remove();
    }
  });

  it('still recognises Reticle UI itself', () => {
    const own = document.createElement('div');
    own.setAttribute('data-reticle-overlay', '');
    const inner = document.createElement('span');
    own.appendChild(inner);
    document.body.appendChild(own);
    try {
      expect(isReticleUi(own)).toBe(true);
      expect(isReticleUi(inner), 'a child of Reticle UI is Reticle UI').toBe(true);
    } finally {
      own.remove();
    }
  });

  it('is not fooled by a marker on body either', () => {
    document.body.setAttribute('data-reticle-something', '');
    const el = document.createElement('p');
    document.body.appendChild(el);
    try {
      expect(isReticleUi(el)).toBe(false);
    } finally {
      document.body.removeAttribute('data-reticle-something');
      el.remove();
    }
  });
});

/**
 * A source stamp is on the APP's elements, not on Reticle's.
 *
 * The Vite and Babel plugins stamp `data-reticle-source` on every element the app renders, and the
 * ancestor walk treated any `data-reticle*` attribute as "Reticle's own UI". So in a stamped app —
 * which is every instrumented app — the answer was yes for essentially the whole page.
 *
 * Two things read this. `pageElementAt` (annotator) skipped every stamped element and marked the
 * outermost UNSTAMPED ancestor instead, so a note taken through the annotate shield anchored to the
 * app shell rather than the thing under the cursor. `occlusion.ts` returns "nothing to report" on a
 * yes, so occlusion detection was off wherever the stamp reached.
 */
describe('a source-stamped app element is page content, not Reticle UI', () => {
  it('does not treat data-reticle-source as Reticle UI', () => {
    const el = document.createElement('button');
    el.setAttribute('data-reticle-source', 'src/App.tsx:12:3');
    document.body.appendChild(el);
    try {
      expect(isReticleUi(el), 'the app rendered this; Reticle only labelled it').toBe(false);
    } finally {
      el.remove();
    }
  });

  it('does not treat a stamped ancestor as Reticle UI either', () => {
    const host = document.createElement('div');
    host.setAttribute('data-reticle-source', 'src/App.tsx:1:1');
    const inner = document.createElement('span');
    host.appendChild(inner);
    document.body.appendChild(host);
    try {
      expect(isReticleUi(inner)).toBe(false);
    } finally {
      host.remove();
    }
  });
});
