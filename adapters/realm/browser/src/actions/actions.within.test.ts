import { describe, it, expect, beforeEach } from 'vitest';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

/**
 * A role anchor keeps the roles of its control's nearest containers. Recorded on a modal's error alert:
 * the dismiss button was anchored as `button "Dismiss error message"`; a correct build named it
 * "Dismiss error", the replay found no such name, and the flow failed. The containers (`alert` inside
 * `dialog`) let a replay find the one button there when the name differs (#2109).
 */
beforeEach(() => {
  document.body.innerHTML = '';
});

describe('act result — the containers of a named control', () => {
  it('reports the nearest container roles, innermost first', async () => {
    document.body.innerHTML =
      '<div role="dialog" aria-label="Add Manual Decision"><form><div role="alert">Permission denied.' +
      '<button aria-label="Dismiss error message">x</button></div></form></div>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const res = await executeAction(refs.refFor(button), 'click', {});
    if (!res.ok) {
      throw new Error('expected ok');
    }
    expect(res.within).toEqual(['alert', 'dialog']);
  });

  it('reports none for a control outside any container role', async () => {
    document.body.innerHTML = '<main><button>Save</button></main>';
    const res = await executeAction(
      refs.refFor(document.querySelector('button') as HTMLElement),
      'click',
      {},
    );
    if (!res.ok) {
      throw new Error('expected ok');
    }
    expect(res.within).toBeUndefined();
  });
});
