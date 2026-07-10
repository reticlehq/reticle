import { afterEach, describe, expect, it } from 'vitest';
import { MarkAnchorStrategy } from '@reticlehq/core';
import { registerAdapter, type ComponentInfo } from '../registry/adapters.js';
import { resolveMarkAnchor } from './mark-anchor.js';

function render(html: string): HTMLElement {
  document.body.innerHTML = html;
  const el = document.body.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('no element rendered');
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('resolveMarkAnchor', () => {
  it('prefers an explicit testid (the gold-standard anchor)', () => {
    const el = render('<button data-testid="checkout">Pay</button>');
    const m = resolveMarkAnchor(el);
    expect(m.strategy).toBe(MarkAnchorStrategy.TESTID);
    expect(m.anchor).toBe('checkout');
    expect(m.label).toBe('button "Pay"');
  });

  it('carries the babel-stamped source file:line even when the anchor is role-based', () => {
    const el = render('<button data-reticle-source="src/Checkout.tsx:42:8">Submit</button>');
    const m = resolveMarkAnchor(el);
    // No component adapter → role tier, but the source rides along for the agent to open.
    expect(m.strategy).toBe(MarkAnchorStrategy.ROLE);
    expect(m.source).toEqual({ file: 'src/Checkout.tsx', line: 42 });
  });

  it('reads source from the nearest ancestor that carries the stamp', () => {
    const root = render('<div data-reticle-source="src/Card.tsx:10:0"><span>x</span></div>');
    const child = root.querySelector('span');
    if (child === null) throw new Error('no child');
    expect(resolveMarkAnchor(child).source).toEqual({ file: 'src/Card.tsx', line: 10 });
  });

  it('uses component@source (tier 2) when an adapter identifies the element with a source', () => {
    registerAdapter({
      name: 'mark-test-component',
      identify: (el: Element): ComponentInfo | null => {
        const owner = el.closest('[data-mark-comp]')?.getAttribute('data-mark-comp');
        return owner === null || owner === undefined
          ? null
          : { componentStack: [owner], source: { file: 'src/Checkout.tsx', line: 42, column: 8 } };
      },
    });
    const el = render('<button data-mark-comp="Submit">Go</button>');
    const m = resolveMarkAnchor(el);
    expect(m.strategy).toBe(MarkAnchorStrategy.COMPONENT);
    expect(m.anchor).toBe('Submit@Checkout.tsx:42');
    expect(m.source).toEqual({ file: 'src/Checkout.tsx', line: 42 });
  });

  it('falls back to a tag-name label when there is no role or accessible name', () => {
    const el = render('<section>untitled</section>');
    const m = resolveMarkAnchor(el);
    expect(m.label.length).toBeGreaterThan(0);
  });
});
