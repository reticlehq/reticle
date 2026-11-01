import { describe, it, expect, beforeEach } from 'vitest';
import { elementsMatching } from './query.js';
import { registerAdapter, type ComponentInfo } from '@/registry/stores/adapters.js';
import { QueryBy } from '@reticlehq/core';

/**
 * A component anchor names a JSX site, and a site's line is the reference implementation's layout.
 * Recorded on a phone-number input: a country item was anchored at PhoneInput.tsx:182, and a correct
 * fix that moved that line could not be graded at all. The item's own words ("(+49) Germany") are what
 * identifies it, on any layout. A component query that carries `text` keeps only the elements whose
 * own text is that text, and still finds them by component name when the recorded line is gone.
 */
const SITE = '../src/PhoneInput/PhoneInput.tsx';

beforeEach(() => {
  document.body.innerHTML = '';
  registerAdapter({
    name: 'text-fake',
    identify: (el: Element): ComponentInfo | null =>
      null === el.closest('[data-component="PhoneInput"]')
        ? null
        : { componentStack: ['PhoneInput'] },
  });
});

function countryList(line: number): void {
  const item = (dial: string, name: string): string =>
    `<li role="presentation" data-reticle-source="${SITE}:${String(line)}:14"><svg aria-label="${name}"></svg> (${dial}) ${name}</li>`;
  document.body.innerHTML =
    '<div data-component="PhoneInput"><input data-reticle-source="' +
    SITE +
    ':160:6" /><ul>' +
    item('+93', 'Afghanistan') +
    item('+49', 'Germany (Deutschland)') +
    item('+81', 'Japan (日本)') +
    '</ul></div>';
}

describe('a component query that carries the element`s own text', () => {
  it('finds the one item with that text at the recorded line', () => {
    countryList(182);
    const found = elementsMatching({
      by: QueryBy.COMPONENT,
      value: 'PhoneInput',
      component: 'PhoneInput',
      source: { file: SITE, line: 182 },
      text: '(+49) Germany (Deutschland)',
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.textContent).toContain('Germany');
  });

  it('still finds it by component name when a correct fix moved the line', () => {
    countryList(205);
    const found = elementsMatching({
      by: QueryBy.COMPONENT,
      value: 'PhoneInput',
      component: 'PhoneInput',
      source: { file: SITE, line: 182 },
      text: '(+49) Germany (Deutschland)',
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.textContent).toContain('Germany');
  });

  it('finds nothing when no element of the component has that text', () => {
    countryList(182);
    const found = elementsMatching({
      by: QueryBy.COMPONENT,
      value: 'PhoneInput',
      component: 'PhoneInput',
      source: { file: SITE, line: 182 },
      text: '(+33) France',
    });
    expect(found).toHaveLength(0);
  });
});
