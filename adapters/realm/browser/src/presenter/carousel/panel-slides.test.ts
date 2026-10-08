/**
 * Text-first Harness value cards are always useful; the offer only appears when eligible.
 */
import { describe, expect, it } from 'vitest';
import { panelSlides } from './panel-slides.js';

const CLAIM_URL = 'https://app.reticle.sh/harness';

describe('panelSlides', () => {
  it('leads with the offer when it applies, followed by product value cards', () => {
    const ids = panelSlides({ claimed: false, claimUrl: CLAIM_URL }, false).map((s) => s.id);
    expect(ids).toEqual(['harness-offer', 'harness-journeys', 'replay-confidence']);
  });

  it('shows the value cards when no offer is known', () => {
    expect(panelSlides(undefined, false).map((s) => s.id)).toEqual([
      'harness-journeys',
      'replay-confidence',
    ]);
  });

  it('keeps the product value cards when somebody already declined the offer', () => {
    expect(panelSlides({ claimed: false, claimUrl: CLAIM_URL }, true).map((s) => s.id)).toEqual([
      'harness-journeys',
      'replay-confidence',
    ]);
  });
});

/** The rail edited without a release: the daemon's notices replace the bundled value slides. */
describe('remote notices', () => {
  it('renders the notices the daemon chose, escaped, in place of the bundled slides', () => {
    const slides = panelSlides(undefined, false, [
      {
        id: 'personas',
        kicker: 'NEW',
        title: 'Five personas <b>at once</b>',
        detail: 'Drives every journey',
        cta: { label: 'See how', url: 'https://reticle.sh/harness?a=1&b=2' },
      },
    ]);
    expect(slides.map((s) => s.id)).toEqual(['notice-personas']);
    const host = document.createElement('div');
    host.innerHTML = slides[0]?.html ?? '';
    expect(host.querySelector('b')).toBeNull();
    expect(host.textContent).toContain('Five personas <b>at once</b>');
    expect(host.querySelector('a')?.getAttribute('href')).toBe(
      'https://reticle.sh/harness?a=1&b=2',
    );
  });

  it('drops a notice that fails the schema, such as a link off our sites', () => {
    const slides = panelSlides(undefined, false, [
      { id: 'ok', title: 'Fine' },
      { id: 'phish', title: 'Bad', cta: { label: 'Go', url: 'https://evil.example/x' } },
      'not a notice',
    ]);
    expect(slides.map((s) => s.id)).toEqual(['notice-ok']);
  });

  it('keeps the bundled slides when the daemon sent none', () => {
    expect(panelSlides(undefined, false, []).map((s) => s.id)).toEqual(
      panelSlides(undefined, false).map((s) => s.id),
    );
  });
});

/** A self-hosted or local platform: its value cards linked to the hosted one. */
describe('the value cards on a platform that is not the hosted one', () => {
  it('link to the platform the daemon uses', () => {
    const html = panelSlides(undefined, false, [], 'http://localhost:18340')
      .map((slide) => slide.html)
      .join('');
    expect(html).toContain('href="http://localhost:18340/settings?group=billing"');
    expect(html).not.toContain('app.reticle.sh');
  });
});
