/**
 * The reported case, driven the way an agent drives it.
 *
 * From the issue: `Orders & invoices` is an `<a href>`, and clicking it was refused with
 * `potentially destructive action blocked` for a money word in its href. The pattern's `payment`
 * matches the singular `/billing/payment` rather than the plural the issue quotes, so that is what
 * the fixture uses — the defect is the same either way: the guard read an ADDRESS as a label.
 *
 * The negative controls below are the point of the narrowing. A guard that fires on navigation
 * teaches an agent to pass `confirmDangerous: true` reflexively, so the block has to be exactly as
 * wide as the acts it protects: a button labelled Delete, and a link the page wired up itself.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

const refTo = (selector: string): string => {
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) throw new Error(`no element for ${selector}`);
  return refs.refFor(el);
};

describe('a plain navigation link is clicked without confirming', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not block a same-origin link whose href carries the money word', async () => {
    document.body.innerHTML = '<a id="orders" href="/billing/payment">Orders &amp; invoices</a>';
    await expect(executeAction(refTo('#orders'), 'click')).resolves.toBeDefined();
  });

  it('does not block a footer link whose TEXT carries the word', async () => {
    document.body.innerHTML = '<a id="refunds" href="/help/refunds">Refund policy</a>';
    await expect(executeAction(refTo('#refunds'), 'click')).resolves.toBeDefined();
  });

  it('still blocks a button labelled Delete', async () => {
    document.body.innerHTML = '<button id="del">Delete account</button>';
    await expect(executeAction(refTo('#del'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  it('still blocks a link the page wired up with an inline handler', async () => {
    document.body.innerHTML =
      '<a id="pay" href="/purchase/confirm" onclick="void 0">Purchase now</a>';
    await expect(executeAction(refTo('#pay'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  it('still blocks a link whose href is executable rather than navigation', async () => {
    document.body.innerHTML = '<a id="js" href="javascript:void 0">Delete account</a>';
    await expect(executeAction(refTo('#js'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  /**
   * A plain link whose TEXT also matches is still exempted — that is the issue's own wording
   * ("whose href or text contains 'payment'"), and the act is still only a GET.
   */
  it('does not block a plain link whose text reads destructively', async () => {
    document.body.innerHTML = '<a id="t" href="/help/delete-account">Delete account</a>';
    await expect(executeAction(refTo('#t'), 'click')).resolves.toBeDefined();
  });

  it('still blocks a role=link on a div, which is not an anchor', async () => {
    document.body.innerHTML = '<div id="fake" role="link" tabindex="0">Delete account</div>';
    await expect(executeAction(refTo('#fake'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  /**
   * A drag END is not navigation. A drop target is exactly what a link looks like, so the end of a
   * drag keeps the text-only answer — dropping a row onto a plainly-styled "Pay" is still a payment.
   */
  it('still blocks a DRAG onto a plain-looking link', async () => {
    document.body.innerHTML =
      '<div id="row" draggable="true">Row</div>' +
      '<a id="drop" href="/billing/payment">Pay now</a>';
    await expect(executeAction(refTo('#row'), 'drag', { toRef: refTo('#drop') })).rejects.toThrow(
      /confirmDangerous/,
    );
  });

  it('still blocks a submit control inside a money-moving form', async () => {
    document.body.innerHTML =
      '<form action="/api/refund"><button type="submit" id="go">Issue refund</button></form>';
    await expect(executeAction(refTo('#go'), 'click')).rejects.toThrow(/confirmDangerous/);
  });
});
