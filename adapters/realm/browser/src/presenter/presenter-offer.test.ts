import { beforeEach, describe, expect, it } from 'vitest';
import {
  OFFER_ATTR,
  OFFER_CLAIM_ATTR,
  OFFER_DISMISSED_KEY,
  OFFER_DISMISS_ATTR,
  OFFER_SLOT_ATTR,
  OFFER_TEXT,
  offerHtml,
  paintOffer,
} from './presenter-offer.js';

/**
 * A dev-only overlay that nags gets switched off once and never comes back, so most of these tests
 * are about the card NOT appearing: when we have not heard from the platform, when there is nowhere
 * to send anybody, and after somebody has already said no.
 */

const CLAIM_URL = 'https://app.reticle.sh/harness';

describe('when the harness offer is shown at all', () => {
  /** Absence means "we have not heard", not "not claimed" — an offline machine advertises nothing. */
  it('says nothing when the daemon reported no offer', () => {
    expect(offerHtml(undefined, false)).toBe('');
  });

  it('says nothing when there is no claim link to send anybody to', () => {
    expect(offerHtml({ claimed: false }, false)).toBe('');
  });

  /**
   * The platform reports a lapsed free period as `claimed:false` with `eligible:false` — identical
   * to never having claimed, apart from this one field. Advertising three free months to the one
   * group who can never accept them again is the one way this card is insulting rather than unwanted.
   */
  it('says nothing to a workspace whose free period has already run out', () => {
    expect(offerHtml({ claimed: false, eligible: false, claimUrl: CLAIM_URL }, false)).toBe('');
  });

  /** An older platform reports no eligibility at all; silence is not a refusal. */
  it('still offers when the platform said nothing about eligibility', () => {
    expect(offerHtml({ claimed: false, claimUrl: CLAIM_URL }, false)).toContain(OFFER_TEXT.CLAIM);
  });

  it('says nothing to somebody who already dismissed it', () => {
    expect(offerHtml({ claimed: false, claimUrl: CLAIM_URL }, true)).toBe('');
  });

  it('pitches the harness, with a claim link, to a user who has not claimed it', () => {
    const html = offerHtml({ claimed: false, claimUrl: CLAIM_URL }, false);
    expect(html).toContain(OFFER_TEXT.HEADLINE);
    expect(html).toContain(OFFER_TEXT.FREE);
    expect(html).toContain(OFFER_TEXT.CLAIM);
    expect(html).toContain(CLAIM_URL);
  });

  /** It is an advert for our own product inside somebody else's app: it opens away from their page. */
  it('opens the platform in a new tab, without handing it this page', () => {
    const html = offerHtml({ claimed: false, claimUrl: CLAIM_URL }, false);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('once the offer has been claimed', () => {
  /** There is no pitch left. Selling somebody something they already own is the fastest way off. */
  it('stops advertising and states the remaining time instead', () => {
    const html = offerHtml({ claimed: true, daysRemaining: 60, claimUrl: CLAIM_URL }, false);
    expect(html).not.toContain(OFFER_TEXT.CLAIM);
    expect(html).toContain('60 days left');
  });

  it('warns as the free period runs out', () => {
    const html = offerHtml({ claimed: true, daysRemaining: 3 }, false);
    expect(html).toContain('ends in 3 days');
  });

  it('says today rather than "in 1 days" on the last day', () => {
    expect(offerHtml({ claimed: true, daysRemaining: 1 }, false)).toContain('ends today');
  });

  /** An expired period is not news anybody can act on here; the platform is where that conversation is. */
  it('goes away when the period is over', () => {
    expect(offerHtml({ claimed: true, daysRemaining: -1 }, false)).toBe('');
  });

  it('says nothing when the platform did not say how long is left', () => {
    expect(offerHtml({ claimed: true }, false)).toBe('');
  });
});

describe('painting it into the HUD', () => {
  let slot: HTMLElement;
  let store: Map<string, string>;
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };

  beforeEach(() => {
    store = new Map();
    document.body.innerHTML = `<div ${OFFER_SLOT_ATTR}></div>`;
    const found = document.querySelector<HTMLElement>(`[${OFFER_SLOT_ATTR}]`);
    if (null === found) throw new Error('no slot');
    slot = found;
  });

  it('puts the card in the slot the shell rendered', () => {
    paintOffer(document, { claimed: false, claimUrl: CLAIM_URL }, storage);
    expect(slot.querySelector(`[${OFFER_ATTR}]`)).not.toBeNull();
    expect(slot.querySelector(`[${OFFER_CLAIM_ATTR}]`)?.getAttribute('href')).toBe(CLAIM_URL);
  });

  /** Somebody who said no has answered the question — including after a reload, which is why it persists. */
  it('remembers a dismissal and does not come back on the next push', () => {
    paintOffer(document, { claimed: false, claimUrl: CLAIM_URL }, storage);
    slot.querySelector<HTMLElement>(`[${OFFER_DISMISS_ATTR}]`)?.click();
    expect(slot.innerHTML).toBe('');
    expect(store.get(OFFER_DISMISSED_KEY)).toBe('1');

    paintOffer(document, { claimed: false, claimUrl: CLAIM_URL }, storage);
    expect(slot.innerHTML).toBe('');
  });

  /** A private window throws on both accessors; the HUD is not allowed to care. */
  it('still paints when the browser refuses local storage', () => {
    const hostile = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    paintOffer(document, { claimed: false, claimUrl: CLAIM_URL }, hostile);
    expect(slot.querySelector(`[${OFFER_ATTR}]`)).not.toBeNull();
    expect(() => {
      slot.querySelector<HTMLElement>(`[${OFFER_DISMISS_ATTR}]`)?.click();
    }).not.toThrow();
  });

  it('clears an earlier card when the daemon stops reporting an offer', () => {
    paintOffer(document, { claimed: false, claimUrl: CLAIM_URL }, storage);
    paintOffer(document, undefined, storage);
    expect(slot.innerHTML).toBe('');
  });
});
