import { describe, expect, it, beforeEach } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '../dom/refs.js';

/**
 * `press` must send the key it was ASKED for, and never a different one.
 *
 * The tool description tells the agent, in the one sentence it reads about arguments:
 *
 *     Action-specific arguments: … { text } for type/press …
 *
 * The implementation read `args['key']` and defaulted to `'Enter'`. So the documented call —
 * `act { action: 'press', args: { text: 'Escape' } }` — sent **Enter**, and reported success.
 *
 * Three separate consequences, worst last:
 *
 *   1. The requested key never arrives, so Escape-to-close and Tab-traversal go unverified while
 *      looking verified. Two field reports were exactly this, both diagnosed by the agent as
 *      "synthetic events do not reach the app" — the wrong root cause, because the event reached
 *      the app perfectly well and simply said `Enter`.
 *   2. It is silent. Nothing in the result says the argument was ignored.
 *   3. **Enter is not a neutral substitute.** On a focused field inside a form it submits it. So a
 *      request to close a dialog could file the form behind it, and the destructive-action guard
 *      above (`assertActionAllowed`) read the same missing `key`, so it classified the call by the
 *      key nobody asked for too.
 *
 * `key` keeps working — it was the de-facto argument for anyone who read the source rather than the
 * description — but `text` is what we document, so it wins when both are present.
 */
describe('press sends the key it was asked for', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const listen = (el: HTMLElement): string[] => {
    const keys: string[] = [];
    el.addEventListener('keydown', (e) => keys.push(e.key));
    return keys;
  };

  it('honours the DOCUMENTED `text` argument', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    const keys = listen(el);
    await executeAction(refs.refFor(el), ActionType.PRESS, { text: 'Escape' });
    expect(keys, 'asked for Escape').toEqual(['Escape']);
  });

  it('never silently substitutes Enter for the key that was requested', async () => {
    // The bug, stated as the thing that must not happen. Enter submits a form; Escape does not.
    const el = document.createElement('input');
    document.body.appendChild(el);
    const keys = listen(el);
    await executeAction(refs.refFor(el), ActionType.PRESS, { text: 'Tab' });
    expect(keys).not.toContain('Enter');
  });

  it('still honours `key`, which is what the source has always read', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    const keys = listen(el);
    await executeAction(refs.refFor(el), ActionType.PRESS, { key: 'Escape' });
    expect(keys).toEqual(['Escape']);
  });

  it('bubbles, so a document-level handler sees it', async () => {
    // The other half of the field report: apps listen on `document`, not on the button.
    const el = document.createElement('button');
    document.body.appendChild(el);
    const atDocument: string[] = [];
    const onDoc = (e: KeyboardEvent): void => void atDocument.push(e.key);
    document.addEventListener('keydown', onDoc);
    await executeAction(refs.refFor(el), ActionType.PRESS, { text: 'Escape' });
    document.removeEventListener('keydown', onDoc);
    expect(atDocument).toEqual(['Escape']);
  });

  it('defaults to Enter only when NO key was named at all', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    const keys = listen(el);
    await executeAction(refs.refFor(el), ActionType.PRESS, {});
    expect(keys).toEqual(['Enter']);
  });
});
