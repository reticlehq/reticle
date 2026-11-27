/**
 * Slack's page requires Trusted Types. The reader mounted its page annotator with `innerHTML` just
 * before it dialled, the browser threw ("This document requires 'TrustedHTML' assignment"), and
 * `connect()` stopped there: the tab never joined, and nothing said why.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Reticle } from './reticle.js';
import { setHtml } from './dom/trusted-html.js';

const dialled: string[] = [];

/** A WebSocket that only records where it was asked to dial. */
class RecordingSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    dialled.push(url);
  }
  send(): void {}
  close(): void {}
}

const innerHtml = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');

afterEach(() => {
  if (innerHtml !== undefined) {
    Object.defineProperty(Element.prototype, 'innerHTML', innerHtml);
  }
  delete (globalThis as Record<string, unknown>)['trustedTypes'];
  dialled.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a page that requires Trusted Types', () => {
  it('still dials the bridge when the page UI cannot be drawn', () => {
    // The browser refuses every plain string written as HTML.
    Object.defineProperty(Element.prototype, 'innerHTML', {
      configurable: true,
      set() {
        throw new TypeError("This document requires 'TrustedHTML' assignment.");
      },
      get() {
        return '';
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reticle = new Reticle();
    vi.stubGlobal('WebSocket', RecordingSocket);
    reticle.connect({ url: 'ws://localhost:4400/reticle' });
    expect(dialled).toEqual(['ws://localhost:4400/reticle']);
    reticle.disconnect();
  });

  it('writes HTML through a policy named reticle, never through the default policy', () => {
    const created: string[] = [];
    (globalThis as Record<string, unknown>)['trustedTypes'] = {
      createPolicy: (name: string, rules: { createHTML: (html: string) => string }) => {
        created.push(name);
        return { createHTML: (html: string) => `trusted:${rules.createHTML(html)}` };
      },
    };
    const written: unknown[] = [];
    Object.defineProperty(Element.prototype, 'innerHTML', {
      configurable: true,
      set(value: unknown) {
        written.push(value);
      },
      get() {
        return '';
      },
    });
    setHtml(document.createElement('div'), '<b>x</b>');
    setHtml(document.createElement('div'), '<i>y</i>');
    expect(created).toEqual(['reticle']);
    expect(written).toEqual(['trusted:<b>x</b>', 'trusted:<i>y</i>']);
  });
});
