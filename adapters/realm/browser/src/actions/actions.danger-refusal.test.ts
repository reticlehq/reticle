/**
 * The destructive-action refusal says what the guard read (#2272).
 *
 * It used to be one fixed sentence: "potentially destructive action blocked; retry with
 * args.confirmDangerous=true". Agents could not tell why a row menu trigger, a "Model" picker
 * button or Enter in a chat composer was refused, so the only move left was confirmDangerous, and an
 * agent that passes it everywhere has switched the guard off. The refusal now names the control,
 * the word and where the word was; a control that only opens a popup is not judged by money words.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

const refTo = (selector: string): string => {
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`no element for ${selector}`);
  }
  return refs.refFor(el);
};

const refusal = async (selector: string, action: string, args = {}): Promise<string> => {
  try {
    await executeAction(refTo(selector), action, args);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('the action was not refused');
};

describe('a refusal names the control, the word and where it was', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('names a button by role and name, and the word in its name', async () => {
    document.body.innerHTML = '<button id="b">Delete account</button>';
    const message = await refusal('#b', 'click');
    expect(message).toContain('button "Delete account" ("delete" in its name)');
    // The prefix and the retry hint stay: error-recovery and telemetry match on them.
    expect(message).toMatch(/^potentially destructive action blocked: /);
    expect(message).toMatch(/; retry with args\.confirmDangerous=true$/);
  });

  it('names the submit button that Enter presses, and the word on it', async () => {
    document.body.innerHTML =
      '<form><label for="n">Account name</label><input id="n" type="text">' +
      '<button type="submit">Delete account</button></form>';
    const message = await refusal('#n', 'press', { text: 'Enter' });
    expect(message).toContain(
      'the submit button Enter presses: button "Delete account" ("delete" in its name)',
    );
    // The field itself is fine, so it is not blamed.
    expect(message).not.toContain('textbox');
  });

  it('names the form action when that is what matched', async () => {
    document.body.innerHTML =
      '<form action="/api/delete-user"><label for="n">Note</label><input id="n" type="text">' +
      '<button type="submit">Save</button></form>';
    const message = await refusal('#n', 'press', { text: 'Enter' });
    expect(message).toContain('"delete" in its form action');
  });

  it('names a title when only the title matched', async () => {
    document.body.innerHTML = '<button id="t" title="Remove row" aria-label="Row 3"></button>';
    const message = await refusal('#t', 'click');
    expect(message).toContain('button "Row 3" ("remove" in its title)');
  });

  it('names the href of a link that navigates somewhere destructive', async () => {
    document.body.innerHTML = '<a id="l" href="/account/delete">Settings</a>';
    const message = await refusal('#l', 'click');
    expect(message).toContain('link "Settings" ("delete" in its href)');
  });
});

describe('a control that only opens a popup is not judged by money words', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not refuse a menu trigger named for a payment', async () => {
    document.body.innerHTML =
      '<button id="m" aria-haspopup="menu">Actions for Payment successful</button>';
    await expect(executeAction(refTo('#m'), 'click')).resolves.toBeDefined();
  });

  it('does not refuse a disclosure button named for a payment', async () => {
    document.body.innerHTML =
      '<button id="d" type="button" aria-expanded="false">Payment details</button>';
    await expect(executeAction(refTo('#d'), 'click')).resolves.toBeDefined();
  });

  it('still refuses a popup trigger whose name destroys something', async () => {
    // A row menu item named Delete IS one; a trigger named Delete is judged the same way. Only money
    // words are dropped for a control that opens something.
    document.body.innerHTML = '<button id="m" aria-haspopup="dialog">Delete project</button>';
    const message = await refusal('#m', 'click');
    expect(message).toContain('"delete" in its name');
  });

  it('still refuses a money word when aria-haspopup is "false"', async () => {
    document.body.innerHTML = '<button id="p" aria-haspopup="false">Pay now</button>';
    const message = await refusal('#p', 'click');
    expect(message).toContain('button "Pay now" ("pay" in its name)');
  });

  it('still refuses a submit button that also carries aria-expanded', async () => {
    // A submit button submits, whatever else it says it does.
    document.body.innerHTML =
      '<form><button id="s" type="submit" aria-expanded="false">Place order</button></form>';
    const message = await refusal('#s', 'click');
    expect(message).toContain('"place order" in its name');
  });
});
