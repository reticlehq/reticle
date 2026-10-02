/**
 * What the chat panel's carousel shows, in order: the harness offer first when the platform says it
 * applies, then the founder invitation, which always applies.
 */
import { describe, expect, it } from 'vitest';
import { panelSlides } from './panel-slides.js';

const CLAIM_URL = 'https://app.reticle.sh/harness';

describe('panelSlides', () => {
  it('leads with the harness offer when it applies, then the founders', () => {
    const ids = panelSlides({ claimed: false, claimUrl: CLAIM_URL }, false).map((s) => s.id);
    expect(ids).toEqual(['harness', 'founders']);
  });

  it('shows only the founders when the platform said nothing about an offer', () => {
    expect(panelSlides(undefined, false).map((s) => s.id)).toEqual(['founders']);
  });

  // Somebody who said "not now" to the harness offer before the carousel existed has answered it.
  it('leaves the offer out for somebody who already declined it', () => {
    expect(panelSlides({ claimed: false, claimUrl: CLAIM_URL }, true).map((s) => s.id)).toEqual([
      'founders',
    ]);
  });
});
