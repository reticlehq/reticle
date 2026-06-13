import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerAdapter, elementHasHoverHandlers, type IrisAdapter } from './adapters.js';

const adapters = ((globalThis as unknown as { __irisAdapters?: IrisAdapter[] }).__irisAdapters ??=
  []);

function clearAdapters(): void {
  adapters.length = 0;
}

beforeEach(clearAdapters);
afterEach(clearAdapters);

describe('elementHasHoverHandlers (F3)', () => {
  it('returns false when no adapter is installed', () => {
    expect(elementHasHoverHandlers(document.createElement('div'))).toBe(false);
  });

  it('returns true when an adapter reports handlers for the element', () => {
    registerAdapter({
      name: 'mock-hover',
      identify: () => null,
      hasHoverHandlers: (el) => el.tagName === 'BUTTON',
    });
    expect(elementHasHoverHandlers(document.createElement('button'))).toBe(true);
    expect(elementHasHoverHandlers(document.createElement('div'))).toBe(false);
  });

  it('skips adapters that do not implement the probe', () => {
    registerAdapter({ name: 'mock-noprobe', identify: () => null });
    expect(elementHasHoverHandlers(document.createElement('button'))).toBe(false);
  });
});
