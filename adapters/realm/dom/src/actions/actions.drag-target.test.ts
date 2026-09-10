import { describe, expect, it, beforeEach } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '../dom/refs.js';

/**
 * A drag whose target could not be resolved is a FAILED call, not a free drag.
 *
 * `drag` takes its drop target from `args.toRef` — and `toRef` appears **nowhere** in the tool
 * description an agent reads. The `args` sentence lists `value`, `text`, `native`, `holdMs` and
 * `confirmDangerous`, and never names the one argument without which the action cannot do its job.
 *
 * So the agent guesses. The field report guessed `target`. Then:
 *
 *   - `asString(args['toRef'])` returns `''`;
 *   - `''` is read as "no target given", which is a legitimate free drag;
 *   - `dragElement(el, null)` runs a drag that lands nowhere, so no `drop` fires;
 *   - and it returns normally — `dispatched: true`, `domMutatedWithin: 2`, settled. **Success.**
 *
 * The report described it as "drag dispatched and settled but never fired the app's onDrop". That is
 * exactly right, and the root cause it proposed — synthetic events not reaching handlers — was
 * exactly wrong. The drag worked. It had nowhere to go.
 *
 * Two fixes, because either alone leaves the trap: accept the argument agents actually send, and
 * refuse when a target WAS named and could not be resolved. A free drag with no target named at all
 * stays legal, because that is a real thing to want.
 */
describe('drag refuses a target it cannot resolve', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const pair = (): { a: HTMLElement; b: HTMLElement } => {
    document.body.innerHTML = '<div id="a">A</div><div id="b">B</div>';
    return {
      a: document.getElementById('a') as HTMLElement,
      b: document.getElementById('b') as HTMLElement,
    };
  };

  it('accepts `target`, which is what an agent with no documentation reaches for', async () => {
    const { a, b } = pair();
    let dropped = false;
    b.addEventListener('mouseup', () => {
      dropped = true;
    });
    await executeAction(refs.refFor(a), ActionType.DRAG, { target: refs.refFor(b) });
    expect(dropped, 'the drag must land on the element that was named').toBe(true);
  });

  it('still accepts `toRef`, the name the source has always read', async () => {
    const { a, b } = pair();
    let dropped = false;
    b.addEventListener('mouseup', () => {
      dropped = true;
    });
    await executeAction(refs.refFor(a), ActionType.DRAG, { toRef: refs.refFor(b) });
    expect(dropped).toBe(true);
  });

  it('REFUSES a named target that does not resolve, instead of dragging nowhere', async () => {
    // The false green. Previously this ran a target-less drag and reported success.
    const { a } = pair();
    await expect(
      executeAction(refs.refFor(a), ActionType.DRAG, { toRef: 'e999-does-not-exist' }),
    ).rejects.toThrow(/e999-does-not-exist/);
  });

  it('still allows a genuine free drag when no target is named at all', async () => {
    const { a } = pair();
    await expect(executeAction(refs.refFor(a), ActionType.DRAG, {})).resolves.toBeDefined();
  });
});
