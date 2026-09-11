/**
 * The guard read what the USER TYPED as if it were the control's label.
 *
 * From a field session against a CFD app. The agent filled the "What are you trying to find out?"
 * box with "Determine the pressure drop and velocity distribution of water flowing through a 3-way
 * pipe junction", pressed Enter, and Reticle refused: `potentially destructive action blocked`.
 *
 * The trigger was the phrase "pressure drop" against `\bdrop\b` in the destructive-label pattern.
 * `dangerousActionContext` joins the element's `textContent` and `value` into the string it
 * classifies, which is right for a button — its text IS its label — and wrong for a text entry,
 * where the content is the user's DATA and the only label is the accessible name.
 *
 * This is how a guard becomes decorative. The reporter passed `confirmDangerous: true` to get past
 * it and noted that doing so reflexively is exactly the failure mode; the same argument already
 * removed `send`, `logout` and `deploy` from this pattern. A false block costs a round trip AND
 * teaches the agent to route around the block, and the routing-around generalises to the controls
 * that do matter.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { executeAction } from './actions.js';
import { refs } from '../dom/refs.js';

const refTo = (selector: string): string => {
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) throw new Error(`no element for ${selector}`);
  return refs.refFor(el);
};

describe('a text entry is classified by its label, never by its content', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not block Enter because the user typed the word "drop"', async () => {
    document.body.innerHTML =
      '<label for="q">What are you trying to find out?</label><textarea id="q"></textarea>';
    const field = document.querySelector('textarea');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('no field');
    field.value = 'Determine the pressure drop of water through a 3-way pipe junction';
    await expect(executeAction(refTo('#q'), 'press', { text: 'Enter' })).resolves.toBeDefined();
  });

  it('does not block a click on an input whose VALUE reads as destructive', async () => {
    // A search box pre-filled with "remove duplicates" is data, not an action.
    document.body.innerHTML =
      '<label for="s">Search</label><input id="s" type="text" value="remove duplicates">';
    await expect(executeAction(refTo('#s'), 'click')).resolves.toBeDefined();
  });

  it('still blocks when the FIELD ITSELF is labelled destructively', async () => {
    // The accessible name is the label, and a field asking you to type DELETE to confirm is exactly
    // the control this guard is for.
    document.body.innerHTML =
      '<label for="c">Type DELETE to remove this account</label><input id="c" type="text">';
    await expect(executeAction(refTo('#c'), 'press', { text: 'Enter' })).rejects.toThrow(
      /confirmDangerous/,
    );
  });

  it('still blocks a destructive BUTTON, whose text really is its label', async () => {
    document.body.innerHTML = '<button id="b">Delete account</button>';
    await expect(executeAction(refTo('#b'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  it('still blocks a submit input, whose value is its label and not data', async () => {
    // `<input type="submit" value="Delete">` is the one input whose value IS the visible label.
    document.body.innerHTML = '<input id="d" type="submit" value="Delete account">';
    await expect(executeAction(refTo('#d'), 'click')).rejects.toThrow(/confirmDangerous/);
  });
});

/**
 * Pressing Enter in a field submits the FORM, so the control that matters is the submit button.
 *
 * The guard read the field and never the button, so `<form><input><button>Delete account</button>`
 * was driven by Enter with no confirmation at all — while the false positive above fired on a field
 * containing the word "drop". Both are the same defect: classifying the wrong text.
 */
describe('Enter in a form is judged by what it submits', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('blocks Enter when the form it submits is a destructive one', async () => {
    document.body.innerHTML =
      '<form><label for="n">Account name</label><input id="n" type="text">' +
      '<button type="submit">Delete account</button></form>';
    await expect(executeAction(refTo('#n'), 'press', { text: 'Enter' })).rejects.toThrow(
      /confirmDangerous/,
    );
  });

  it('allows Enter when the form it submits is ordinary', async () => {
    document.body.innerHTML =
      '<form><label for="n">Search</label><input id="n" type="text">' +
      '<button type="submit">Search</button></form>';
    await expect(executeAction(refTo('#n'), 'press', { text: 'Enter' })).resolves.toBeDefined();
  });

  it('does not judge a NON-Enter key by the form — it submits nothing', async () => {
    document.body.innerHTML =
      '<form><label for="n">Account name</label><input id="n" type="text">' +
      '<button type="submit">Delete account</button></form>';
    await expect(executeAction(refTo('#n'), 'press', { text: 'Escape' })).resolves.toBeDefined();
  });
});

/**
 * Picking a value is not performing the act it feeds.
 *
 * Two more false positives from the same field session, both still live after the submit-control
 * fix above. Choosing "Inlet" from two radio-like choices was blocked, and pressing Enter in a
 * textarea was blocked while clicking the adjacent submit button -- same form, same handler, same
 * effect -- was not.
 *
 * The reporter's summary is the cost, and it is why narrowing is the safe direction: "I ended up
 * passing confirmDangerous: true reflexively on every action, which is how a safety guard becomes
 * decoration." A guard that fires on picking a value is not protecting the destructive action
 * either. The negative controls below are what keep the narrowing honest -- a false block costs a
 * round trip, a missed block cannot be undone (#894).
 */
describe('a value picker is judged by what the choice feeds, not by the choice', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not block a radio whose label reads like the action it will cause', async () => {
    document.body.innerHTML =
      '<form action="/api/refund"><input type="radio" id="r" name="reason" aria-label="Refund">' +
      '<button type="submit">Continue</button></form>';
    await expect(executeAction(refTo('#r'), 'check')).resolves.toBeDefined();
  });

  it('still blocks the submit that the choice feeds', async () => {
    // The act is the submit, judged on its own terms. That is the whole argument for exempting the
    // choice, so it has to hold.
    document.body.innerHTML =
      '<form action="/api/refund"><input type="radio" id="r" name="reason" aria-label="Refund">' +
      '<button type="submit" id="go">Issue refund</button></form>';
    await expect(executeAction(refTo('#go'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  it('still blocks a checkbox, which is also how a one-click confirmation is spelled', async () => {
    document.body.innerHTML = '<input type="checkbox" id="w" aria-label="Delete this repository">';
    await expect(executeAction(refTo('#w'), 'check')).rejects.toThrow(/confirmDangerous/);
  });

  it('still blocks a menuitem, because a menu item labelled Delete IS one', async () => {
    document.body.innerHTML = '<button role="menuitem" id="d">Delete project</button>';
    await expect(executeAction(refTo('#d'), 'click')).rejects.toThrow(/confirmDangerous/);
  });
});

describe('Enter in a textarea submits nothing, so it triggers nothing', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it("is not judged by the form's submit button", async () => {
    // Enter here inserts a newline. Blocking it refuses the one keystroke on the page that does the
    // least, beside a button whose click would be judged the same way and allowed.
    document.body.innerHTML =
      '<form><label for="n">Notes</label><textarea id="n"></textarea>' +
      '<button type="submit">Delete account</button></form>';
    await expect(executeAction(refTo('#n'), 'press', { text: 'Enter' })).resolves.toBeDefined();
  });

  it('still blocks a click on that submit button from the same form', async () => {
    document.body.innerHTML =
      '<form><label for="n">Notes</label><textarea id="n"></textarea>' +
      '<button type="submit" id="go">Delete account</button></form>';
    await expect(executeAction(refTo('#go'), 'click')).rejects.toThrow(/confirmDangerous/);
  });
});
