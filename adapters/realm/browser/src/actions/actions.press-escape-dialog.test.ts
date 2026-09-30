// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

/**
 * `press Escape` inside a modal `<dialog>` closes it the way a keyboard does (#1123).
 *
 * A dispatched key is untrusted and gets no default action, so the dialog's close request never ran:
 * no `cancel`, no `close`, and an app that closes through `onCancel` looked broken. jsdom has no
 * `showModal()`, `:modal` or `close()`, so the fixture supplies the modal state and the engine
 * methods a browser has, and the tests pin what Reticle does with them.
 */
function modalDialog(opts: { requestClose: boolean; modal?: boolean }): {
  dialog: HTMLDialogElement;
  button: HTMLButtonElement;
  seen: string[];
} {
  document.body.innerHTML = '<dialog open><button>Keep editing</button></dialog>';
  const dialog = document.querySelector('dialog') as HTMLDialogElement;
  const button = document.querySelector('button') as HTMLButtonElement;
  const seen: string[] = [];
  const modal = opts.modal ?? true;
  const matches = dialog.matches.bind(dialog);
  dialog.matches = (selector: string) => (':modal' === selector ? modal : matches(selector));
  const close = (): void => {
    dialog.removeAttribute('open');
    seen.push('close');
  };
  dialog.close = close;
  dialog.addEventListener('cancel', () => seen.push('cancel'));
  if (opts.requestClose) {
    // What a browser's requestClose does: a cancelable `cancel`, then close unless it was prevented.
    dialog.requestClose = () => {
      if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) close();
    };
  } else {
    Object.defineProperty(dialog, 'requestClose', { value: undefined });
  }
  return { dialog, button, seen };
}

const escape = async (el: HTMLElement): Promise<unknown> =>
  executeAction(refs.refFor(el), ActionType.PRESS, { key: 'Escape' });

describe.each([
  ['with requestClose', true],
  ['without requestClose', false],
])('Escape in a modal dialog, %s', (_label, requestClose) => {
  it('fires cancel and closes the dialog', async () => {
    const { dialog, button, seen } = modalDialog({ requestClose });

    await escape(button);

    expect(seen).toEqual(['cancel', 'close']);
    expect(dialog.open).toBe(false);
  });

  it('leaves it open when the app prevents cancel', async () => {
    const { dialog, button, seen } = modalDialog({ requestClose });
    dialog.addEventListener('cancel', (event) => event.preventDefault());

    await escape(button);

    expect(seen).toEqual(['cancel']);
    expect(dialog.open).toBe(true);
  });
});

describe('Escape is left alone where a browser would not close anything', () => {
  it('a keydown the app prevented does not reach the dialog', async () => {
    const { dialog, button, seen } = modalDialog({ requestClose: true });
    button.addEventListener('keydown', (event) => event.preventDefault());

    await escape(button);

    expect(seen).toEqual([]);
    expect(dialog.open).toBe(true);
  });

  it('a non-modal open dialog has no close request on Escape', async () => {
    const { dialog, button, seen } = modalDialog({ requestClose: true, modal: false });

    await escape(button);

    expect(seen).toEqual([]);
    expect(dialog.open).toBe(true);
  });

  it('another key does nothing to the dialog', async () => {
    const { dialog, button, seen } = modalDialog({ requestClose: true });

    await executeAction(refs.refFor(button), ActionType.PRESS, { key: 'Tab' });

    expect(seen).toEqual([]);
    expect(dialog.open).toBe(true);
  });
});

describe('every way to press Escape reaches the dialog the same way', () => {
  it('as a chord, keys: ["Escape"]', async () => {
    const { dialog, button, seen } = modalDialog({ requestClose: true });

    await executeAction(refs.refFor(button), ActionType.PRESS, { keys: ['Escape'] });

    expect(seen).toEqual(['cancel', 'close']);
    expect(dialog.open).toBe(false);
  });

  it('held: the dialog closes on the first keydown, before the repeats', async () => {
    const { dialog, button } = modalDialog({ requestClose: true });
    const openAtEachKeydown: boolean[] = [];
    button.addEventListener('keydown', () => openAtEachKeydown.push(dialog.open));

    await executeAction(refs.refFor(button), ActionType.PRESS, { key: 'Escape', holdMs: 120 });

    expect(openAtEachKeydown.length).toBeGreaterThan(1);
    expect(openAtEachKeydown[0], 'the first keydown sees the dialog still open').toBe(true);
    expect(openAtEachKeydown.slice(1), 'the repeats run against a closed dialog').not.toContain(
      true,
    );
  });

  it('from a non-modal dialog nested inside the modal one', async () => {
    const { dialog, seen } = modalDialog({ requestClose: true });
    const inner = document.createElement('dialog');
    inner.setAttribute('open', '');
    const field = document.createElement('button');
    field.textContent = 'Inner';
    inner.append(field);
    dialog.append(inner);

    await escape(field);

    expect(seen).toEqual(['cancel', 'close']);
    expect(dialog.open).toBe(false);
  });
});
