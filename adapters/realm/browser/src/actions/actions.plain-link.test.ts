/**
 * The reported case, driven the way the SDK drives it, on a page with no CDP session.
 *
 * From the issue: `Orders & invoices` is an `<a href>`, and clicking it was refused with
 * `potentially destructive action blocked` for a money word in its href. The pattern's `payment`
 * matches the singular `/billing/payment` rather than the plural the issue quotes, so that is what
 * the fixture uses: the defect is the same either way, the guard read an ADDRESS as a label.
 *
 * The exemption that fixes it needs a reading that a link has NO handler, and this path cannot take
 * one. The SDK sees the DOM and any framework's props, and a listener bound with `addEventListener`
 * is in neither. So on this path the block STAYS, which is what a page with no CDP session gets, and
 * the tests below pin exactly that. The exemption is proven where a CDP session exists: the
 * classifier with a real reading in `server/src/surface/tools/act/act-danger.test.ts`, and the
 * reading itself from a real browser in `test/click-listeners.integration.test.ts`.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { executeAction } from './actions.js';
import { refs } from '@/dom/addressing/refs.js';

const refTo = (selector: string): string => {
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) throw new Error(`no element for ${selector}`);
  return refs.refFor(el);
};

describe('a plain navigation link on a page with no CDP session', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * The honest answer, and the one divshekhar asked for: with nothing able to prove a link
   * handlerless, the block stays. This is the reported link, still refused.
   */
  it('still blocks the reported link, because nothing on this path can prove it handlerless', async () => {
    document.body.innerHTML = '<a id="orders" href="/billing/payment">Orders &amp; invoices</a>';
    await expect(executeAction(refTo('#orders'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  it('still blocks a link with a handler installed via addEventListener', async () => {
    document.body.innerHTML = '<a id="wired" href="/account/delete">Delete account</a>';
    const wired = document.querySelector('#wired');
    if (!(wired instanceof HTMLAnchorElement)) throw new Error('fixture element missing');
    // A real handler the DOM will not report through any attribute.
    wired.addEventListener('click', (event) => event.preventDefault());
    await expect(executeAction(refTo('#wired'), 'click')).rejects.toThrow(/confirmDangerous/);
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

  it('still blocks a role=link on a div, which is not an anchor', async () => {
    document.body.innerHTML = '<div id="fake" role="link" tabindex="0">Delete account</div>';
    await expect(executeAction(refTo('#fake'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  /**
   * A drag END is not navigation. A drop target is exactly what a link looks like, so the end of a
   * drag keeps the text-only answer, and dropping a row onto a plainly-styled "Pay" is still a
   * payment.
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

  /**
   * A framework that rewrites the click into a non-GET request.
   *
   * Rails' `link_to method: :delete`, Turbo and UJS all render an href that reads as a GET and
   * intercept the click in script to issue a DELETE. The marker is read from the element, so the
   * block holds on this path even before any handler reading is considered.
   */
  it('blocks a link marked data-method="delete"', async () => {
    document.body.innerHTML =
      '<a id="rails" href="/account" data-method="delete">Delete account</a>';
    await expect(executeAction(refTo('#rails'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  it('blocks a link marked data-turbo-method="delete"', async () => {
    document.body.innerHTML =
      '<a id="turbo" href="/account" data-turbo-method="delete">Delete account</a>';
    await expect(executeAction(refTo('#turbo'), 'click')).rejects.toThrow(/confirmDangerous/);
  });

  it('blocks a link marked hx-delete', async () => {
    document.body.innerHTML =
      '<a id="htmx" href="/account" hx-delete="/account">Delete account</a>';
    await expect(executeAction(refTo('#htmx'), 'click')).rejects.toThrow(/confirmDangerous/);
  });
});
