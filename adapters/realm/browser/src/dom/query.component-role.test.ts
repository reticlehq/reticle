import { describe, it, expect, beforeEach } from 'vitest';
import { elementsMatching } from './query.js';
import { registerAdapter, type ComponentInfo } from '@/registry/stores/adapters.js';
import { QueryBy } from '@reticlehq/core';

/**
 * A nameless control with no own words has one identity a layout cannot move: its role. Recorded on
 * a phone-number input: the country toggle (`<div role="none">` holding a flag) was anchored at
 * PhoneInput.tsx:123. On another correct layout that line held the flag's SVG paths, the query
 * matched the paths, and the replay could not grade the build. A component query that carries `role`
 * keeps only the elements with that role, and finds them by component name when the line is gone.
 */
const SITE = '../src/PhoneInput/PhoneInput.tsx';

beforeEach(() => {
  document.body.innerHTML = '';
  registerAdapter({
    name: 'role-fake',
    identify: (el: Element): ComponentInfo | null =>
      null === el.closest('[data-component="PhoneInput"]')
        ? null
        : { componentStack: ['PhoneInput'] },
  });
});

/** Two phone inputs. The toggle is written at `toggleLine`; the flag's path at `pathLine`. */
function phoneInputs(toggleLine: number, pathLine: number): void {
  const one =
    '<div data-component="PhoneInput">' +
    `<div role="none" class="flag-wrapper" data-reticle-source="${SITE}:${String(toggleLine)}:8">` +
    `<svg><path data-reticle-source="${SITE}:${String(pathLine)}:14"></path>` +
    `<path data-reticle-source="${SITE}:${String(pathLine)}:14"></path></svg></div>` +
    `<input data-reticle-source="${SITE}:160:6" /></div>`;
  document.body.innerHTML = one + one;
}

const TOGGLE = {
  by: QueryBy.COMPONENT,
  value: 'PhoneInput',
  component: 'PhoneInput',
  source: { file: SITE, line: 123 },
  role: 'none',
} as const;

describe('a component query that carries the element`s role', () => {
  it('finds the toggles at the recorded line', () => {
    phoneInputs(123, 140);
    const found = elementsMatching(TOGGLE);
    expect(found).toHaveLength(2);
    expect(found.every((el) => el.classList.contains('flag-wrapper'))).toBe(true);
  });

  it('does not take other elements that a correct layout wrote on that line', () => {
    phoneInputs(111, 123);
    const found = elementsMatching(TOGGLE);
    expect(found).toHaveLength(2);
    expect(found.every((el) => el.classList.contains('flag-wrapper'))).toBe(true);
  });

  it('without a role, answers as before', () => {
    phoneInputs(111, 123);
    const { role: _role, ...noRole } = TOGGLE;
    expect(elementsMatching(noRole).every((el) => 'path' === el.localName)).toBe(true);
  });
});
