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
