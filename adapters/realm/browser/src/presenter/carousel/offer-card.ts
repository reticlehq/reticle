/**
 * The one thing this HUD advertises, and the rules that keep it from becoming an advert.
 *
 * Reticle can drive an app and verify it without the developer holding a model API key, and almost
 * nobody knows that — it is behind a tool call, in a daemon, named after a thing they have never
 * heard of. A product nobody discovers is the same as a product that does not exist, and the HUD is
 * the one surface a developer already has open while Reticle is running.
 *
 * So it is shown here, under four rules that are not negotiable, because a dev-only overlay that
 * nags gets switched off once and never comes back:
 *
 *   1. ONLY when we know. Absence of the offer means "we have not heard", not "not claimed". An
 *      offline machine, an unlinked project or an older daemon says nothing, so this says nothing.
 *   2. ONLY when there is a door. No claim URL, no card — a pitch you cannot act on is noise.
 *   3. ONCE claimed it stops selling. It becomes a quiet line of remaining time, which is
 *      information the person actually wants, and then it goes away entirely.
 *   4. DISMISSIBLE, and the dismissal sticks. Per browser, in local storage, and it survives every
 *      reload. Somebody who said no has answered the question.
 */

/** Root of the offer card, so the shell can find and replace it. */
export const OFFER_ATTR = 'data-reticle-offer';
/** The claim button — a link, because the answer lives on the platform. */
export const OFFER_CLAIM_ATTR = 'data-reticle-offer-claim';

/**
 * Where a dismissal is remembered.
 *
 * Deliberately NOT session storage. "Not interested" asked again on every reload is the same as not
 * having a dismiss button, and the person is reloading constantly — that is what a dev server is.
 */
export const OFFER_DISMISSED_KEY = 'reticle.harnessOffer.dismissed';

/** What the card says. Named because a string a user reads is a decision, not an implementation detail. */
export const OFFER_TEXT = {
  HEADLINE: 'Get Harness free for 3 months',
  BODY: 'The harness explores your app, proves what works, and saves every journey as a test that replays for free. Built on Jev — no model API key needed.',
  CLAIM: 'Claim now',
  /** The old per-card "no". Kept only so the test can assert it is gone: the carousel closes now. */
  DISMISS: 'Not now',
  /** Shown once claimed, while the period is comfortably live. */
  claimed: (days: number): string => `Harness active — ${String(days)} days left`,
  /** The last stretch, where the number stops being trivia and starts being a decision. */
  ending: (days: number): string =>
    1 >= days
      ? 'Harness free period ends today'
      : `Harness free period ends in ${String(days)} days`,
} as const;

/** Below this many days remaining, the status line starts saying it is ending rather than active. */
const ENDING_SOON_DAYS = 14;

/** Read the stored dismissal, treating an unreadable store as "not dismissed". */
export function offerDismissed(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    return '1' === storage?.getItem(OFFER_DISMISSED_KEY);
  } catch {
    // A private window, blocked site data, or a thumbnail capture. Failing closed here would hide
    // the offer from everybody in those modes; failing open shows it, which is the ordinary case.
    return false;
  }
}

/** The offer as the daemon reports it. Structural, so the presenter needs no schema import. */
export interface OfferState {
  claimed: boolean;
  daysRemaining?: number | undefined;
  claimUrl?: string | undefined;
  /**
   * Whether claiming would still grant anything.
   *
   * `claimed` means "running right now", so a free period that ran out reads exactly like one that
   * was never taken. Pitching at that person advertises something they cannot accept, which is the
   * one way this card can be actively insulting rather than merely unwanted. Absent means offerable.
   */
  eligible?: boolean | undefined;
  /**
   * Whether a drive could actually run. Absent means the platform did not say, which reads as yes.
   *
   * Separate from `eligible`, which is about the OFFER. This is about the thing being offered: a
   * deployment holding no key for this project's provider entitles a workspace to a harness that
   * cannot start.
   */
  drivable?: boolean | undefined;
}

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The card's markup, or empty when there is nothing honest to show.
 *
 * Empty is the common answer and deliberately so: unknown, dismissed, claimed-and-not-ending, or
 * no door to send anybody through. Every one of those is a reason to stay quiet.
 */
export function offerHtml(offer: OfferState | undefined, dismissed: boolean): string {
  if (offer === undefined) return '';

  if (offer.claimed) {
    const days = offer.daysRemaining;
    if (days === undefined || 0 > days) return '';
    // Once claimed there is no pitch left, only a fact — and only while the fact is still useful.
    const text = ENDING_SOON_DAYS >= days ? OFFER_TEXT.ending(days) : OFFER_TEXT.claimed(days);
    return `<div ${OFFER_ATTR} class="reticle-offer reticle-offer-claimed">${escape(text)}</div>`;
  }

  // A free period that has run out: nothing to claim and nothing to count down. The platform is
  // where that conversation continues, and this card is not the place to start it.
  if (false === offer.eligible) return '';
  /*
   * Entitled to something that cannot run.
   *
   * The platform reports which providers it holds a key for, and a deployment with none entitles a
   * workspace to a harness that will not start. Selling three free months of that spends the one
   * claim somebody gets and produces the exact shape this product refuses everywhere else: every
   * signal green, the thing underneath unusable. Silence is the honest answer, and it is the same
   * answer this file already gives when there is no door to send anybody through.
   */
  if (false === offer.drivable) return '';
  if (dismissed) return '';
  const url = offer.claimUrl;
  if (url === undefined || 0 === url.length) return '';

  return `<div ${OFFER_ATTR} class="reticle-offer" role="note">
      <span class="reticle-offer-title">${escape(OFFER_TEXT.HEADLINE)}</span>
      <p class="reticle-offer-body">${escape(OFFER_TEXT.BODY)}</p>
      <a ${OFFER_CLAIM_ATTR} class="reticle-offer-claim" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(OFFER_TEXT.CLAIM)}</a>
    </div>`;
}

/** Styles, kept beside the markup they dress so a change to one is a change to both. */
export const OFFER_CSS = `
.reticle-offer{margin:8px 10px;padding:10px 12px;border:1px solid var(--reticle-line,#2a2f3a);border-radius:10px;background:var(--reticle-surface-inset,rgba(255,255,255,.03));}
.reticle-offer-title{display:block;font-weight:600;font-size:12px;padding-right:18px;}
.reticle-offer-body{margin:6px 0 8px;font-size:11px;line-height:1.45;opacity:.8;}
.reticle-offer-claim{display:inline-block;font-size:11px;font-weight:600;padding:4px 10px;border-radius:6px;background:var(--reticle-accent,#4f7cff);color:#fff;text-decoration:none;}
.reticle-offer-claimed{margin:6px 10px;font-size:10px;opacity:.6;}
`;
