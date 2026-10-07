/**
 * Text-first cards for the rail under every open page: a live Harness offer first, when the
 * platform confirms it applies, then the daemon's notices, or the bundled value slides when it sent
 * none.
 */
import { offerHtml, type OfferState } from './offer-card.js';
import type { Slide } from './carousel.js';
import { HudNoticeSchema, type HudNotice } from '@reticlehq/core/hud';
import { esc } from '../chrome/presenter-safe-html.js';
import { DEFAULT_PLATFORM_URL } from '@reticlehq/core';

/**
 * Credits and plans live on the Plan screen; the console has no /harness page (it redirected home).
 * On the platform the daemon uses, which `base` names already escaped.
 */
const HARNESS_PATH = '/settings?group=billing';
export const SLIDE_ID = {
  HARNESS: 'harness-journeys',
  REPLAY: 'replay-confidence',
  OFFER: 'harness-offer',
} as const;

const valueSlides = (base: string): readonly Slide[] => [
  {
    id: SLIDE_ID.HARNESS,
    html: `<div class="reticle-promo-copy"><span class="reticle-promo-kicker">RETICLE HARNESS</span><strong class="reticle-promo-title">Let Reticle drive your app for you</strong><span class="reticle-promo-detail">Describe a user; it drives the journey and saves it to replay.</span><a data-reticle-promo-link class="reticle-promo-link" href="${base}${HARNESS_PATH}" target="_blank" rel="noopener noreferrer">Explore →</a></div>`,
  },
  {
    id: SLIDE_ID.REPLAY,
    html: `<div class="reticle-promo-copy"><span class="reticle-promo-kicker">FROM RUN TO REGRESSION</span><strong class="reticle-promo-title">Keep every journey replayable</strong><span class="reticle-promo-detail">Catch what changes before users do.</span><a data-reticle-promo-link class="reticle-promo-link" href="${base}${HARNESS_PATH}" target="_blank" rel="noopener noreferrer">See how →</a></div>`,
  },
];

/** Slide ids for remote notices are namespaced so they can never collide with a bundled one. */
const NOTICE_SLIDE_PREFIX = 'notice-';

/** One notice the daemon chose, as a slide. Every field is text from the network, so all of it is escaped. */
function noticeSlide(notice: HudNotice): Slide {
  const kicker =
    notice.kicker === undefined
      ? ''
      : `<span class="reticle-promo-kicker">${esc(notice.kicker)}</span>`;
  const detail =
    notice.detail === undefined
      ? ''
      : `<span class="reticle-promo-detail">${esc(notice.detail)}</span>`;
  const link =
    notice.cta === undefined
      ? ''
      : `<a data-reticle-promo-link class="reticle-promo-link" href="${esc(notice.cta.url)}" target="_blank" rel="noopener noreferrer">${esc(notice.cta.label)} →</a>`;
  return {
    id: `${NOTICE_SLIDE_PREFIX}${notice.id}`,
    html: `<div class="reticle-promo-copy">${kicker}<strong class="reticle-promo-title">${esc(notice.title)}</strong>${detail}${link}</div>`,
  };
}

/**
 * The rail's slides: a live harness offer first when there is one, then the daemon's notices, or the
 * bundled value slides when the daemon sent none (offline, an older daemon, nothing applies).
 */
export function panelSlides(
  offer: OfferState | undefined,
  offerDeclined: boolean,
  notices: readonly unknown[] = [],
  base: string = DEFAULT_PLATFORM_URL,
): Slide[] {
  const harnessOffer = offerHtml(offer, offerDeclined);
  // Validated here, in the lazy panel, with the full schema: the snapshot carries them loosely so
  // the first-load schema stays small. A notice that fails is dropped on its own.
  const valid = notices.flatMap((n): HudNotice[] => {
    const parsed = HudNoticeSchema.safeParse(n);
    return parsed.success ? [parsed.data] : [];
  });
  return [
    ...('' === harnessOffer ? [] : [{ id: SLIDE_ID.OFFER, html: harnessOffer }]),
    ...(0 < valid.length ? valid.map(noticeSlide) : valueSlides(base)),
  ];
}
