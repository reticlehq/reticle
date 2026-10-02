/**
 * What the chat panel's carousel shows, in order.
 *
 * The harness offer first, only when its own rules say it applies (the platform reported it, there is
 * a door to send somebody through, it has not been declined); the founder invitation after it, always.
 */
import { offerHtml, type OfferState } from './offer-card.js';
import type { Slide } from './carousel.js';
import { talkCardHtml } from './talk-card.js';

export const SLIDE_ID = { HARNESS: 'harness', FOUNDERS: 'founders' } as const;

export function panelSlides(offer: OfferState | undefined, offerDeclined: boolean): Slide[] {
  const harness = offerHtml(offer, offerDeclined);
  return [
    ...('' === harness ? [] : [{ id: SLIDE_ID.HARNESS, html: harness }]),
    { id: SLIDE_ID.FOUNDERS, html: talkCardHtml() },
  ];
}
