/**
 * The server's positive consent on an action answers that action's own `confirm()` with yes (#2167).
 * The server sends it only from a caller's own `confirmDangerous` on `reticle_act`,
 * `reticle_act_and_wait` or `reticle_act_sequence`.
 *
 * Reticle answers a `confirm()` that a driven click opens with no, so that the tab cannot wedge.
 * Before this change there was no way to answer yes. A destructive flow behind a confirm could not
 * be driven through its button, so agents called the API directly and skipped the code under test.
 *
 * The caller says yes up front, on the action, and the yes is spent on one dialog of that one
 * dispatch. Every other dialog is still declined.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DANGEROUS_ACTION_CONFIRM_ARG, DIALOG_CONSENT_ARG, EventType } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { installDialogs } from '@/observers/dialogs.js';
import type { Emit, Teardown } from '@/observers/types.js';
import { refs } from '@/dom/addressing/refs.js';

/** What the server sends for a caller's own `confirmDangerous`: the flag and the positive consent. */
const YES = { [DANGEROUS_ACTION_CONFIRM_ARG]: true, [DIALOG_CONSENT_ARG]: true } as const;

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

  it('answers yes with the positive consent, and the event says so', async () => {
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

  // #2167 review: confirmDangerous alone only lets the press go. A declaration, a crawl, a replay and
  // an older daemon all send it without the positive consent, and the confirm is answered no.
  it('answers no to confirmDangerous without the positive consent', async () => {
    const answers = guarded('b', 'Delete this item?');
    await executeAction(refTo('#b'), 'click', { [DANGEROUS_ACTION_CONFIRM_ARG]: true });
    expect(answers, 'the press went through, and the confirm was declined').toEqual([false]);
    expect(answered).toEqual([false]);
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
    // during the overlap cannot be told apart, so the safe answer is no. The overlap withdraws the
    // flagged action's yes for the rest of its dispatch, also after the plain one ended.
    const held = guarded('held', 'Delete this item?');
    const plain = guarded('plain', 'Discard the draft?');
    const flagged = executeAction(refTo('#held'), 'click', { ...YES, holdMs: 60 });
    await executeAction(refTo('#plain'), 'click');
    await flagged;
    expect(plain, 'the plain action never said yes').toEqual([false]);
    expect(held, 'the overlap withdrew the yes of the flagged click').toEqual([false]);
  });

  it('declines the held plain click when a flagged action starts beside it', async () => {
    // The other order: the plain click is still held when the flagged one starts. The plain click's
    // confirm comes on its pointerup, while the flagged action is in flight, and must stay a no.
    const held = guarded('held', 'Delete this item?');
    const flaggedTarget = guarded('plain', 'Discard the draft?');
    const plain = executeAction(refTo('#held'), 'click', { holdMs: 60 });
    await executeAction(refTo('#plain'), 'click', YES);
    await plain;
    expect(held, 'the held plain click never got the yes').toEqual([false]);
    expect(flaggedTarget, 'the flagged action was not alone, so it had no yes').toEqual([false]);
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
