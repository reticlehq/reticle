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
import { setOutwardPolicy, submitControlFor } from './danger-context.js';
import { refs } from '@/dom/addressing/refs.js';

const refTo = (selector: string): string => {
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`no element for ${selector}`);
  }
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
    if (!(field instanceof HTMLTextAreaElement)) {
      throw new Error('no field');
    }
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
 * Another false positive from the same field session, still live after the submit-control fix
 * above: choosing "Inlet" from two radio-like choices was blocked.
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

describe('submitControlFor across realms', () => {
  const DESTRUCTIVE_SUBMIT_LABEL = 'Delete account';

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const iframeField = (): Element => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const iframeDoc = iframe.contentDocument;
    if (!iframeDoc) {
      throw new Error('no iframe document');
    }
    iframeDoc.body.innerHTML = `<form><input type="text" id="q"><button type="submit">${DESTRUCTIVE_SUBMIT_LABEL}</button></form>`;
    const field = iframeDoc.querySelector('#q');
    if (!field) {
      throw new Error('no field');
    }
    return field;
  };

  it('finds a submit button inside a same-origin iframe', () => {
    // The button lives in the iframe's realm, so the ambient
    // `instanceof HTMLElement` check this replaced would miss it, and the
    // Enter destructive-guard would never see the submit button.
    const field = iframeField();
    const button = field.ownerDocument.querySelector('button');
    if (!button) {
      throw new Error('no button');
    }
    // Documents the old failure: the ambient realm cannot see the iframe button.
    expect(button instanceof HTMLElement).toBe(false);
    expect(submitControlFor(field as HTMLElement)).toBe(button);
  });

  it('blocks Enter in a same-origin iframe when the form it submits is destructive', async () => {
    // End to end through the press path: the guard must see the iframe's
    // submit button, not just submitControlFor in isolation.
    const field = iframeField();
    await expect(executeAction(refs.refFor(field), 'press', { text: 'Enter' })).rejects.toThrow(
      /confirmDangerous/,
    );
  });
});

/** An issue link whose title read "Checkout pay fails" was blocked as a payment. */
describe('a link is judged by where it goes, not by the text it shows', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not block a link whose text reads as destructive', async () => {
    document.body.innerHTML =
      '<a id="i" href="/issues/42">Checkout pay fails when the button is disabled</a>';
    await expect(executeAction(refTo('#i'), 'click')).resolves.toBeDefined();
  });

  it('still blocks a link that goes somewhere destructive, or one that goes nowhere', async () => {
    document.body.innerHTML =
      '<a id="d" href="/account/delete">Account</a><a id="b" href="#">Delete account</a>';
    await expect(executeAction(refTo('#d'), 'click')).rejects.toThrow(/confirmDangerous/);
    await expect(executeAction(refTo('#b'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  // #1275: "Orders & invoices" to a billing page was refused. Opening a page moves no money.
  it('does not block a link to a same-app page whose path has a money word', async () => {
    document.body.innerHTML =
      '<a id="p" href="/billing/payments">Orders &amp; invoices</a>' +
      '<a id="q" href="/billing/payment">Orders &amp; invoices</a>' +
      '<a id="r" href="/shop/buy">Shop</a>';
    for (const id of ['#p', '#q', '#r']) {
      await expect(executeAction(refTo(id), 'click')).resolves.toBeDefined();
    }
  });

  it('still blocks a link to a payment provider, and a Pay button', async () => {
    document.body.innerHTML =
      '<a id="s" href="https://checkout.stripe.com/c/pay/xyz">Continue</a>' +
      '<button id="b">Pay now</button>';
    await expect(executeAction(refTo('#s'), 'click')).rejects.toThrow(/confirmDangerous/);
    await expect(executeAction(refTo('#b'), 'click')).rejects.toThrow(/confirmDangerous/);
  });
});

/*
 * From persona drives: the Harness pressed Invite in a customer's workspace though its journey
 * said not to. A Harness command a model chose presses an outward control only when its journey
 * asked for that action — `confirmDangerous` in the model's own args does not lift it.
 */
describe('what a Harness command may press', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setOutwardPolicy(undefined);
  });

  it('refuses Invite, Send, Remove and Pay unless the journey asked', async () => {
    document.body.innerHTML =
      '<button id="i">Invite</button><button id="s">Send message</button>' +
      '<button id="r">Remove member</button>';
    setOutwardPolicy([]);
    for (const id of ['#i', '#s', '#r']) {
      await expect(executeAction(refTo(id), 'click', { confirmDangerous: true })).rejects.toThrow(
        /not done \(outward action\)/,
      );
    }
  });

  it('presses the one the journey asked for, and an ordinary control always', async () => {
    document.body.innerHTML = '<button id="i">Invite</button><button id="o">Open Runs</button>';
    setOutwardPolicy(['invite']);
    await expect(executeAction(refTo('#i'), 'click')).resolves.toBeDefined();
    setOutwardPolicy([]);
    await expect(executeAction(refTo('#o'), 'click')).resolves.toBeDefined();
  });

  // Three of four explores failed on "Start free trial" refused as "would need to pay". The payment
  // boundary is typing card details or leaving for a payment provider, not a button's words.
  it('presses Start free trial, Upgrade and Subscribe on the app under test', async () => {
    document.body.innerHTML =
      '<button id="t">Start free trial</button><button id="u">Upgrade</button>' +
      '<button id="s">Subscribe</button>';
    setOutwardPolicy([]);
    for (const id of ['#t', '#u', '#s']) {
      await expect(executeAction(refTo(id), 'click')).resolves.toBeDefined();
    }
  });

  it('refuses to type into a card field or follow a link to a payment provider', async () => {
    document.body.innerHTML =
      '<input id="n" autocomplete="cc-number"><input id="c" name="cvc" inputmode="numeric">' +
      '<input id="e" name="email" autocomplete="email">' +
      '<a id="l" href="https://checkout.stripe.com/c/pay/cs_1">Continue</a>';
    setOutwardPolicy([]);
    for (const id of ['#n', '#c']) {
      await expect(executeAction(refTo(id), 'fill', { value: '4242' })).rejects.toThrow(
        /would need to pay/,
      );
    }
    await expect(executeAction(refTo('#l'), 'click')).rejects.toThrow(/would need to pay/);
    await expect(executeAction(refTo('#e'), 'fill', { value: 'a@b.test' })).resolves.toBeDefined();
  });

  it('types card details when the journey asks to pay', async () => {
    document.body.innerHTML = '<input id="n" autocomplete="cc-number">';
    setOutwardPolicy(['pay']);
    await expect(executeAction(refTo('#n'), 'fill', { value: '4242' })).resolves.toBeDefined();
  });

  it('gates nothing for an agent or a saved flow (no policy)', async () => {
    document.body.innerHTML = '<button id="i">Invite</button>';
    await expect(executeAction(refTo('#i'), 'click')).resolves.toBeDefined();
  });
});

/*
 * Persona drives: `select` with the option's visible label ('Only if "Sign in" passed') was refused
 * with its own label in the list of choices. An option is named by its value, or by the one label
 * a person reads on it.
 */
describe('select by what a person reads', () => {
  it('chooses the one option carrying that label', async () => {
    document.body.innerHTML =
      '<label for="w">When</label><select id="w"><option value="always">Always</option>' +
      '<option value="persona-1|passed">Only if “Sign in” passed</option></select>';
    await executeAction(refTo('#w'), 'select', { value: 'Only if “Sign in” passed' });
    expect((document.querySelector('#w') as HTMLSelectElement).value).toBe('persona-1|passed');
  });

  it('still refuses a name no option has', async () => {
    document.body.innerHTML = '<select id="w"><option value="a">A</option></select>';
    await expect(executeAction(refTo('#w'), 'select', { value: 'Nope' })).rejects.toThrow(
      /no <option>/,
    );
  });
});

/**
 * Half B of #894: a filename-like token never reads as an action verb.
 *
 * The guard read a control's accessible name plus its whole textContent, so a media clip tile
 * whose filename contained "remove" was blocked as destructive, and so was a "Create preview"
 * button whose name carried that filename. Filename tokens are stripped before the text is
 * classified; everything else still counts, including the content of list items and table rows.
 */
describe('a filename-like token never reads as an action verb', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not block picking a material whose filename contains a destructive word', async () => {
    // The maintainer's repro: <div role="option">photo-remove-background.webm</div> then click.
    document.body.innerHTML =
      '<div role="option" data-testid="clip">photo-remove-background.webm</div>';
    await expect(executeAction(refTo('[data-testid="clip"]'), 'click')).resolves.toBeDefined();
  });

  it('does not block a treeitem whose descendant content mentions a destructive word', async () => {
    document.body.innerHTML =
      '<div role="treeitem" aria-label="Clip details">photo-remove-background.webm</div>';
    await expect(executeAction(refTo('[role="treeitem"]'), 'click')).resolves.toBeDefined();
  });

  it('does not block a listbox row whose text is a destructive-looking filename', async () => {
    document.body.innerHTML = '<div role="row">delete-me.txt</div>';
    await expect(executeAction(refTo('[role="row"]'), 'click')).resolves.toBeDefined();
  });

  it('does not block a button whose name carries a filename with a destructive word', async () => {
    // "Create preview" plus the clip filename: the verb is in the filename, not in the act.
    document.body.innerHTML =
      '<button id="p" aria-label="Create preview photo-remove-background.webm">Create preview</button>';
    await expect(executeAction(refTo('#p'), 'click')).resolves.toBeDefined();
  });

  it('still blocks a selectable item the author labelled as destructive', async () => {
    document.body.innerHTML =
      '<div role="treeitem" aria-label="Remove clip">photo-remove-background.webm</div>';
    await expect(executeAction(refTo('[role="treeitem"]'), 'click')).rejects.toThrow(
      /confirmDangerous/,
    );
  });

  it('still blocks a button whose own name is destructive', async () => {
    document.body.innerHTML = '<button id="d">Remove clip</button>';
    await expect(executeAction(refTo('#d'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  it('still blocks when the destructive word stands alone next to a filename', async () => {
    document.body.innerHTML = '<button id="d">Remove photo-remove-background.webm</button>';
    await expect(executeAction(refTo('#d'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  it('still blocks a button whose hyphenated label is a destructive slug', async () => {
    // Review case on #1620: delete-account is a label, not a filename, so nothing is stripped.
    document.body.innerHTML = '<button id="d">delete-account</button>';
    await expect(executeAction(refTo('#d'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  it('still blocks a button whose hyphenated label starts with a destructive word', async () => {
    document.body.innerHTML = '<button id="d">Force-delete</button>';
    await expect(executeAction(refTo('#d'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  it('still blocks a button whose aria-label joins a destructive word with an underscore', async () => {
    document.body.innerHTML = '<button id="d" aria-label="delete_repo">X</button>';
    await expect(executeAction(refTo('#d'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  it('still blocks a list item whose content is destructive', async () => {
    // Review case on #1620: getRole reports `listitem` with no role attribute, so a
    // selection-role branch would judge this by aria-label/title/href alone and let it through.
    document.body.innerHTML = '<ul><li data-testid="m">Delete project</li></ul>';
    await expect(executeAction(refTo('[data-testid="m"]'), 'click')).rejects.toThrow(
      /confirmDangerous/,
    );
  });

  it('still blocks a table row whose content is destructive', async () => {
    document.body.innerHTML = '<table><tr data-testid="r"><td>Delete</td></tr></table>';
    await expect(executeAction(refTo('[data-testid="r"]'), 'click')).rejects.toThrow(
      /confirmDangerous/,
    );
  });

  it('still blocks a verb glued to a filename with a colon', async () => {
    // Review case on #1620: `Delete:report.pdf` — only `report.pdf` is a filename token.
    document.body.innerHTML = '<button id="d">Delete:report.pdf</button>';
    await expect(executeAction(refTo('#d'), 'click')).rejects.toThrow(/confirmDangerous/);
  });
});
