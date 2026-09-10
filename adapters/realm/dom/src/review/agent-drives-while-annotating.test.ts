import { afterEach, describe, expect, it } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { Annotator } from './annotator.js';
import { executeAction } from '../actions/actions.js';
import { refs } from '../dom/refs.js';

/**
 * Annotate mode cancels page clicks to place a mark. That is right for a person and wrong for the
 * agent, so Reticle marks its own dispatches (`synthetic-input.ts`) and the annotator lets those
 * through. The guard existed and only the CHECK/UNCHECK branch used it — the ordinary `click`
 * action goes through `fireClickSequence`, which dispatched unmarked. So with annotate mode on,
 * every `reticle_act` click was swallowed while the action still reported `dispatched: true`, and
 * the agent's own click opened an annotation popover. A false green in Reticle's own UI.
 *
 * The test that existed called `asSyntheticInput` itself before dispatching, so it proved the guard
 * worked and never that the click path used it. Drive the real action instead.
 */
let current: Annotator | undefined;
afterEach(() => {
  current?.toggle(false);
  current?.destroy();
  current = undefined;
  document.body.innerHTML = '';
});

function annotating(): Annotator {
  const ann = new Annotator({ emit: () => undefined, now: () => 0 });
  ann.mount();
  ann.toggle(true);
  current = ann;
  return ann;
}

describe('the agent can still drive the page while a person is annotating', () => {
  it('delivers a click action to the page instead of turning it into a mark', async () => {
    annotating();
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    let received = 0;
    btn.addEventListener('click', () => (received += 1));

    await executeAction(refs.refFor(btn), ActionType.CLICK, {});

    expect(received, 'the page must receive the agent click').toBe(1);
    expect(
      document.querySelector('[data-reticle-mark="pop"]'),
      'the agent click must not open an annotation popover',
    ).toBeNull();
  });

  it("still captures a person's click as a mark", () => {
    annotating();
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    expect(ev.defaultPrevented, "a person's click is still captured").toBe(true);
  });
});
