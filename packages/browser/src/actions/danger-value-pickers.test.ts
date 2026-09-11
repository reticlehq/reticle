/**
 * A guard that fires on picking a value is not protecting the destructive action either.
 *
 * Two false positives from one field session, both still live after the submit-control fix:
 *
 *   - choosing **"Inlet"** from two radio-like choices was blocked
 *   - pressing **Enter in a textarea** was blocked, while clicking the adjacent submit button --
 *     same form, same handler, same effect -- was not
 *
 * The reporter's summary is the cost, and it is the reason narrowing is the safe direction here:
 *
 *   "I ended up passing confirmDangerous: true reflexively on every action, which is how a safety
 *    guard becomes decoration."
 *
 * Both halves keep their negative controls below, because the guard is asymmetric on purpose: a
 * false block costs a round trip, a missed block cannot be undone (#894).
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { executeAction } from './actions.js';
import { refs } from '../dom/refs.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

const ref = (id: string): string => refs.refFor(document.getElementById(id) as HTMLElement);

describe('choosing a value is not performing the act it feeds', () => {
  it('does not block a radio whose label reads like the action it will cause', () => {
    document.body.innerHTML = `
      <form action="/api/refund">
        <input type="radio" id="reason" name="reason" aria-label="Refund" />
        <button type="submit">Continue</button>
      </form>`;

    return expect(executeAction(ref('reason'), 'check')).resolves.toBeDefined();
  });

  it('still blocks the submit that the choice feeds', async () => {
    // The act is the submit, and it is judged on its own terms. That is the whole argument for
    // exempting the choice, so it has to hold.
    document.body.innerHTML = `
      <form action="/api/refund">
        <input type="radio" id="reason" name="reason" aria-label="Refund" />
        <button type="submit" id="go">Issue refund</button>
      </form>`;

    await expect(executeAction(ref('go'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  it('still blocks a checkbox, which is also how a one-click confirmation is spelled', async () => {
    document.body.innerHTML =
      '<input type="checkbox" id="wipe" aria-label="Delete this repository" />';

    await expect(executeAction(ref('wipe'), 'check')).rejects.toThrow(/confirmDangerous/);
  });

  it('still blocks a menuitem, because a menu item labelled Delete IS one', async () => {
    document.body.innerHTML = '<button role="menuitem" id="del">Delete project</button>';

    await expect(executeAction(ref('del'), 'click')).rejects.toThrow(/confirmDangerous/);
  });
});

describe('Enter in a textarea submits nothing, so it triggers nothing', () => {
  it('is not judged by the form\'s submit button', async () => {
    // Enter here inserts a newline. Blocking it refuses the one keystroke on the page that does
    // the least, next to a button whose click would be judged the same way and allowed.
    document.body.innerHTML = `
      <form action="/settings">
        <textarea id="notes"></textarea>
        <button type="submit">Delete account</button>
      </form>`;

    await expect(
      executeAction(ref('notes'), 'press', { text: 'Enter' }),
    ).resolves.toBeDefined();
  });

  it('still blocks Enter in a single-line field, which DOES submit', async () => {
    document.body.innerHTML = `
      <form action="/settings">
        <input id="confirm" />
        <button type="submit">Delete account</button>
      </form>`;

    await expect(executeAction(ref('confirm'), 'press', { text: 'Enter' })).rejects.toThrow(
      /confirmDangerous/,
    );
  });

  it('still blocks a click on that submit button from the same form', async () => {
    document.body.innerHTML = `
      <form action="/settings">
        <textarea id="notes"></textarea>
        <button type="submit" id="go">Delete account</button>
      </form>`;

    await expect(executeAction(ref('go'), 'click')).rejects.toThrow(/confirmDangerous/);
  });
});
