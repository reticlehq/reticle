/**
 * A framework error dialog that covers the page must reach the verdict (#1768).
 *
 * The SDK ignores the Next.js dev overlay's nodes, so a text check on content under an open error
 * dialog matched and passed. A screenshot showed the dialog over the whole page. A match on content
 * under an open dialog now carries `coveredBy`, so the engine cannot answer a plain `yes`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { matchQuery } from './query.js';

afterEach(() => {
  document.body.innerHTML = '';
});

/** A custom element with an open shadow root that holds `inner`, as Next and Vite mount theirs. */
function mountOverlay(tag: string, inner: string): void {
  const host = document.createElement(tag);
  host.attachShadow({ mode: 'open' }).innerHTML = inner;
  document.body.appendChild(host);
}

describe('a framework error dialog over the page', () => {
  it('names the Next.js error dialog on a match under it', () => {
    document.body.innerHTML = '<p>Welcome back</p>';
    mountOverlay('nextjs-portal', '<div data-nextjs-dialog>Unhandled Runtime Error</div>');
    expect(matchQuery({ text: 'Welcome back', matchCase: true }).coveredBy).toBe(
      'Next.js error dialog',
    );
  });

  it('says nothing for the Next.js toast or dev-tools button, which cover nothing', () => {
    document.body.innerHTML = '<p>Welcome back</p>';
    mountOverlay('nextjs-portal', '<div data-nextjs-toast>1 issue</div><button>N</button>');
    expect(matchQuery({ text: 'Welcome back', matchCase: true }).coveredBy).toBeUndefined();
  });

  // Next 16 wraps the error overlay in React `<Activity>`. A collapse to the issue badge keeps the
  // dialog mounted and sets `display: none` on its top node, and every check read `covered`.
  it('says nothing when the Next.js dialog is collapsed to the issue badge', () => {
    document.body.innerHTML = '<p>Welcome back</p>';
    mountOverlay(
      'nextjs-portal',
      '<div data-nextjs-dialog-overlay style="display: none !important">' +
        '<div data-nextjs-dialog>Unhandled Runtime Error</div></div>' +
        '<button data-issues>1 Issue</button>',
    );
    expect(matchQuery({ text: 'Welcome back', matchCase: true }).coveredBy).toBeUndefined();
  });

  // An app can hide Next's whole dev UI with CSS on `nextjs-portal`. The dialog inside is then
  // not on screen, so it covers nothing.
  it('says nothing when CSS hides the Next.js portal itself', () => {
    document.body.innerHTML = '<p>Welcome back</p>';
    mountOverlay('nextjs-portal', '<div data-nextjs-dialog>Unhandled Runtime Error</div>');
    const portal = document.querySelector('nextjs-portal');
    portal?.setAttribute('style', 'display: none');
    expect(matchQuery({ text: 'Welcome back', matchCase: true }).coveredBy).toBeUndefined();
  });

  it('names the Vite error overlay on a match under it, but not on its own text', () => {
    document.body.innerHTML = '<p>Welcome back</p>';
    mountOverlay('vite-error-overlay', '<div class="window"><pre>Failed to compile</pre></div>');
    expect(matchQuery({ text: 'Welcome back', matchCase: true }).coveredBy).toBe(
      'Vite error overlay',
    );
    expect(matchQuery({ text: 'Failed to compile', matchCase: true }).coveredBy).toBeUndefined();
  });

  it('says nothing when no error dialog is open', () => {
    document.body.innerHTML = '<p>Welcome back</p>';
    const result = matchQuery({ text: 'Welcome back', matchCase: true });
    expect(result.matched).toBe(true);
    expect(result.coveredBy).toBeUndefined();
  });
});
