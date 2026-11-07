/**
 * `confirmDangerous: true` on an action answers that action's own `confirm()` with yes (#2167).
 *
 * Reticle answers a `confirm()` that a driven click opens with no, so that the tab cannot wedge.
 * Before this change there was no way to answer yes. A destructive flow behind a confirm could not
 * be driven through its button, so agents called the API directly and skipped the code under test.
 *
 * The caller says yes up front, on the action, and the yes is spent on one dialog of that one
 * dispatch. Every other dialog is still declined.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { installDialogs } from '@/observers/dialogs.js';
import type { Emit, Teardown } from '@/observers/types.js';
import { refs } from '@/dom/addressing/refs.js';

const YES = { confirmDangerous: true } as const;

const refTo = (selector: string): string => {
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`no element for ${selector}`);
  }
  return refs.refFor(el);
};

/** A button whose click handler asks `confirm()` once for each message, and records each answer. */
function guarded(id: string, ...messages: string[]): unknown[] {
  const answers: unknown[] = [];
  const button = document.createElement('button');
  button.id = id;
  button.textContent = 'Continue';
  button.addEventListener('click', () => {
    for (const message of messages) {
      answers.push(window.confirm(message));
    }
  });
  document.body.append(button);
  return answers;
}

describe('confirmDangerous answers the confirm() of its own dispatch', () => {
  type Slots = Record<'alert' | 'confirm' | 'prompt', unknown>;
  const slots = window as unknown as Slots;
  const native: Slots = { alert: slots.alert, confirm: slots.confirm, prompt: slots.prompt };
  let teardown: Teardown | undefined;
  let answered: unknown[] = [];

  beforeEach(() => {
    document.body.innerHTML = '';
    answered = [];
    const emit: Emit = (type, data) => {
      if (type === EventType.DIALOG_OPENED) {
        answered.push(data['answered']);
      }
    };
    teardown = installDialogs(emit);
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    slots.alert = native.alert;
    slots.confirm = native.confirm;
    slots.prompt = native.prompt;
  });

  it('answers yes with confirmDangerous: true, and the event says so', async () => {
    const answers = guarded('b', 'Delete this item?');
    await executeAction(refTo('#b'), 'click', YES);
    expect(answers).toEqual([true]);
    expect(answered).toEqual([true]);
  });

  it('still answers no without the flag', async () => {
    const answers = guarded('b', 'Delete this item?');
    await executeAction(refTo('#b'), 'click');
    await executeAction(refTo('#b'), 'click', { confirmDangerous: false });
    expect(answers).toEqual([false, false]);
    expect(answered).toEqual([false, false]);
  });

  it('spends the yes on one dialog: a second confirm in the same dispatch is declined', async () => {
    const answers = guarded('b', 'Delete this item?', 'Delete it everywhere too?');
    await executeAction(refTo('#b'), 'click', YES);
    expect(answers).toEqual([true, false]);
  });

  it('does not carry the yes to the next action', async () => {
    const answers = guarded('b', 'Delete this item?');
    await executeAction(refTo('#b'), 'click', YES);
    await executeAction(refTo('#b'), 'click');
    expect(answers).toEqual([true, false]);
  });

  it('keeps declining prompt with the flag', async () => {
    const answers: unknown[] = [];
    document.body.innerHTML = '<button id="b">Continue</button>';
    document.querySelector('#b')?.addEventListener('click', () => {
      answers.push(window.prompt('Type the name to confirm'));
    });
    await executeAction(refTo('#b'), 'click', YES);
    expect(answers).toEqual([null]);
  });

  it('declines while an action without the flag is in flight beside it', async () => {
    // Two actions can overlap: a held click awaits between pointerdown and pointerup. A confirm
    // during the overlap cannot be told apart, so the safe answer is no.
    const held = guarded('held', 'Delete this item?');
    const plain = guarded('plain', 'Discard the draft?');
    const flagged = executeAction(refTo('#held'), 'click', { ...YES, holdMs: 60 });
    await executeAction(refTo('#plain'), 'click');
    await flagged;
    expect(plain, 'the plain action never said yes').toEqual([false]);
    expect(held, 'the flagged click lands after the plain one ended').toEqual([true]);
  });

  it('leaves a confirm the PERSON opens during a flagged action alone', async () => {
    let nativeCalled = false;
    teardown?.();
    slots.confirm = (): boolean => {
      nativeCalled = true;
      return false;
    };
    teardown = installDialogs(() => undefined);
    const held = guarded('held', 'Delete this item?');
    const flagged = executeAction(refTo('#held'), 'click', { ...YES, holdMs: 60 });
    // Not inside a Reticle dispatch: the page's own confirm runs, and the yes is not spent on it.
    expect(window.confirm('Leave this page?')).toBe(false);
    await flagged;
    expect(nativeCalled).toBe(true);
    expect(held).toEqual([true]);
  });

  it('does not reach a confirm the handler opens after an await or a timer (stated limit)', async () => {
    // Only a confirm() opened synchronously inside the dispatched event is Reticle's to answer. One
    // opened after an await or a timer runs outside the dispatch, so the page's own confirm runs and
    // the yes is not given: the documented limit of confirmDangerous.
    const reached: string[] = [];
    teardown?.();
    slots.confirm = (message?: string): boolean => {
      reached.push(String(message));
      return false;
    };
    teardown = installDialogs(() => undefined);
    let settled!: () => void;
    const done = new Promise<void>((resolve) => (settled = resolve));
    let pending = 2;
    const answers: unknown[] = [];
    document.body.innerHTML = '<button id="a">Delete</button><button id="t">Delete</button>';
    const finish = (answer: boolean): void => {
      answers.push(answer);
      pending -= 1;
      if (0 === pending) {
        settled();
      }
    };
    document.querySelector('#a')?.addEventListener('click', () => {
      void Promise.resolve().then(() => finish(window.confirm('after an await')));
    });
    document.querySelector('#t')?.addEventListener('click', () => {
      setTimeout(() => finish(window.confirm('after a timer')), 0);
    });
    await executeAction(refTo('#a'), 'click', YES);
    await executeAction(refTo('#t'), 'click', YES);
    await done;
    expect(reached).toEqual(['after an await', 'after a timer']);
    expect(answers).toEqual([false, false]);
  });
});
