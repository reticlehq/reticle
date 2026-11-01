import { describe, it, expect, beforeEach } from 'vitest';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';
import { registerAdapter, type ComponentInfo } from '@/registry/stores/adapters.js';

/**
 * A component anchor names a JSX site, and a list renders every item from one site. Measured on a
 * phone-number input: about 240 country items share one source line, so a click recorded on
 * "Germany" was anchored by component and source alone and a replay could not tell it from any other
 * country. The act result now says where the element sits among the elements that same component
 * query matches, in the order a replay resolves them, so the recorder can keep the position.
 */
beforeEach(() => {
  document.body.innerHTML = '';
  registerAdapter({
    name: 'position-fake',
    identify: (el: Element): ComponentInfo | null => {
      const owner = el.closest('[data-component]');
      const name = owner?.getAttribute('data-component');
      if (null === name || name === undefined) {
        return null;
      }
      return { componentStack: [name], source: { file: 'src/CountryList.tsx', line: 182 } };
    },
  });
});

describe('act result — position among the elements of one component anchor', () => {
  it('reports which of several same-site items was acted on, and how many there were', async () => {
    document.body.innerHTML =
      '<ul data-component="CountryList">' +
      '<li><button>(+93) Afghanistan</button></li>' +
      '<li><button>(+49) Germany</button></li>' +
      '<li><button>(+81) Japan</button></li>' +
      '</ul>';
    const germany = document.querySelectorAll('button')[1] as HTMLButtonElement;
    const res = await executeAction(refs.refFor(germany), 'click', {});
    if (!res.ok) {
      throw new Error('expected ok');
    }
    expect(res.component).toBe('CountryList');
    expect(res.componentNth).toBe(1);
    expect(res.componentOf).toBe(3);
  });

  it('reports no position for the only element of its anchor', async () => {
    document.body.innerHTML = '<div data-component="Toolbar"><button>Save</button></div>';
    const save = document.querySelector('button') as HTMLButtonElement;
    const res = await executeAction(refs.refFor(save), 'click', {});
    if (!res.ok) {
      throw new Error('expected ok');
    }
    expect(res.componentNth).toBeUndefined();
    expect(res.componentOf).toBeUndefined();
  });
});

/**
 * The words that identify a nameless item. A country item has no accessible name (role
 * presentation), so the recorder anchored it by component and source line only, which is the
 * reference implementation's layout. The act result now carries the item's own words, so the
 * anchor can survive a correct change that moves the line.
 */
describe('act result — the own words of an element with no accessible name', () => {
  it('reports them for a nameless list item', async () => {
    document.body.innerHTML =
      '<ul data-component="CountryList">' +
      '<li role="presentation">(+93) Afghanistan</li>' +
      '<li role="presentation">  (+49)   Germany (Deutschland) </li>' +
      '</ul>';
    const germany = document.querySelectorAll('li')[1] as HTMLElement;
    const res = await executeAction(refs.refFor(germany), 'click', {});
    if (!res.ok) {
      throw new Error('expected ok');
    }
    expect(res.ownText).toBe('(+49) Germany (Deutschland)');
  });

  it('does not report them for a control that has an accessible name', async () => {
    document.body.innerHTML = '<div data-component="Toolbar"><button>Save</button></div>';
    const save = document.querySelector('button') as HTMLButtonElement;
    const res = await executeAction(refs.refFor(save), 'click', {});
    if (!res.ok) {
      throw new Error('expected ok');
    }
    expect(res.ownText).toBeUndefined();
  });
});

/**
 * The position is counted among the elements a replay will resolve, and a replay of a nameless
 * element keeps only the elements with its role. Counted among every element of the component, the
 * recorded count did not match the replayed count, and the replay could not choose.
 */
describe('act result — position among the elements of one component anchor with that role', () => {
  it('counts only the elements with the same role', async () => {
    document.body.innerHTML =
      '<div data-component="PhoneInput">' +
      '<span role="img" aria-label="flag"></span><div role="none"></div>' +
      '<span role="img" aria-label="flag"></span><div role="none"></div>' +
      '</div>';
    const second = document.querySelectorAll('[role="none"]')[1] as HTMLElement;
    const res = await executeAction(refs.refFor(second), 'click', {});
    if (!res.ok) {
      throw new Error('expected ok');
    }
    expect(res.role).toBe('none');
    expect(res.componentNth).toBe(1);
    expect(res.componentOf).toBe(2);
  });
});
